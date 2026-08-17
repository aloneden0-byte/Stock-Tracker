const STORAGE_KEY = "portfolio";

// Known cost basis (ILS) supplied by the user for the initial holdings, split evenly
// since the exact per-ticker breakdown wasn't available. Used both as the default for
// new installs and to backfill anyone whose saved state still has costBasisILS: null.
const KNOWN_COST_BASIS_ILS = { QQQ: 65182.35, VOO: 65182.35 };

const DEFAULT_STATE = {
  holdings: [
    { ticker: "QQQ", shares: 33.25, costBasisILS: KNOWN_COST_BASIS_ILS.QQQ },
    { ticker: "VOO", shares: 34.21, costBasisILS: KNOWN_COST_BASIS_ILS.VOO },
  ],
  lastUpdated: null,
};

const RANGE_DAYS = { "1M": 30, "3M": 90, "6M": 182, "1Y": 365 };
const PALETTE_COUNT = 5;

const STOOQ_QUOTE_URL = (tickers) =>
  `https://stooq.com/q/l/?s=${tickers.map((t) => `${t.toLowerCase()}.us`).join(",")}&f=sd2t2ohlcv&h&e=csv`;
const STOOQ_HISTORY_URL = (ticker) => `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}.us&i=d`;
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const CORS_PROXY = (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;

function backfillKnownCostBasis(s) {
  let changed = false;
  for (const holding of s.holdings) {
    if (!holding.costBasisILS && KNOWN_COST_BASIS_ILS[holding.ticker] !== undefined) {
      holding.costBasisILS = KNOWN_COST_BASIS_ILS[holding.ticker];
      changed = true;
    }
  }
  return changed;
}

let state = loadState();
if (backfillKnownCostBasis(state)) saveState();
let prices = {}; // ticker -> { usd, source: 'api' | 'manual' }
let fxRate = null; // ILS per USD
let fxSource = null; // 'api' | 'manual'
let lastBannerMessages = [];
let historyCache = {}; // ticker -> [{date, close}] | 'error'
let selectedTicker = state.holdings[0] ? state.holdings[0].ticker : null;
let currentRange = "1Y";
let chartInstance = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    if (!parsed.holdings || !Array.isArray(parsed.holdings)) {
      return structuredClone(DEFAULT_STATE);
    }
    return parsed;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function ilsFormat(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: "ILS",
    maximumFractionDigits: 2,
  }).format(n);
}

function usdFormat(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

function percentFormat(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function paletteIndex(ticker) {
  let sum = 0;
  for (let i = 0; i < ticker.length; i++) sum += ticker.charCodeAt(i);
  return sum % PALETTE_COUNT;
}

// ---------- Market data fetching ----------

async function fetchWithTimeout(url, ms = 6000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithCorsFallback(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error("bad status");
    return res;
  } catch {
    const res = await fetchWithTimeout(CORS_PROXY(url));
    if (!res.ok) throw new Error("proxy bad status");
    return res;
  }
}

async function fetchPrices(tickers) {
  const res = await fetchWithCorsFallback(STOOQ_QUOTE_URL(tickers));
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const symbolIdx = header.indexOf("SYMBOL");
  const closeIdx = header.indexOf("CLOSE");
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const symbol = (cols[symbolIdx] || "").replace(".US", "").toUpperCase();
    const close = parseFloat(cols[closeIdx]);
    if (symbol && !Number.isNaN(close) && close > 0) {
      result[symbol] = close;
    }
  }
  return result;
}

async function fetchFxRate() {
  const res = await fetchWithTimeout(FX_URL);
  if (!res.ok) throw new Error("fx request failed");
  const data = await res.json();
  const rate = data?.rates?.ILS;
  if (!rate) throw new Error("ILS rate missing");
  return rate;
}

async function fetchHistory(ticker) {
  const res = await fetchWithCorsFallback(STOOQ_HISTORY_URL(ticker));
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("no history data");
  const header = lines[0].split(",").map((h) => h.trim().toUpperCase());
  const dateIdx = header.indexOf("DATE");
  const closeIdx = header.indexOf("CLOSE");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = cols[dateIdx];
    const close = parseFloat(cols[closeIdx]);
    if (date && !Number.isNaN(close)) rows.push({ date, close });
  }
  if (rows.length === 0) throw new Error("no parsable history rows");
  return rows;
}

async function refreshHistoryFor(tickers) {
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        historyCache[ticker] = await fetchHistory(ticker);
      } catch {
        if (!Array.isArray(historyCache[ticker])) historyCache[ticker] = "error";
      }
    })
  );
}

async function refreshMarketData() {
  const banner = document.getElementById("status-banner");
  const tickers = state.holdings.map((h) => h.ticker);
  let priceError = null;
  let fxError = null;

  const priceTask =
    tickers.length > 0
      ? fetchPrices(tickers)
          .then((fetched) => {
            for (const ticker of tickers) {
              if (fetched[ticker] !== undefined) {
                prices[ticker] = { usd: fetched[ticker], source: "api" };
              } else if (!prices[ticker]) {
                priceError = "לא ניתן היה למצוא מחיר עבור אחד או יותר מהטיקרים.";
              }
            }
          })
          .catch(() => {
            priceError = "שליפת מחירי המניות מהאינטרנט נכשלה (ייתכן חסימת רשת/CORS).";
          })
      : Promise.resolve();

  const fxTask = fetchFxRate()
    .then((rate) => {
      fxRate = rate;
      fxSource = "api";
    })
    .catch(() => {
      fxError = "שליפת שער הדולר-שקל נכשלה (ייתכן חסימת רשת/CORS).";
    });

  await Promise.all([priceTask, fxTask]);

  lastBannerMessages = [priceError, fxError].filter(Boolean);
  if (lastBannerMessages.length > 0) {
    renderStatusBanner(lastBannerMessages);
  } else {
    banner.classList.add("hidden");
    banner.innerHTML = "";
  }

  state.lastUpdated = new Date().toISOString();
  saveState();

  if (tickers.length > 0) {
    await refreshHistoryFor(tickers);
  }

  render();
}

function renderStatusBanner(messages) {
  const banner = document.getElementById("status-banner");
  banner.classList.remove("hidden");
  banner.innerHTML = "";

  const msgEl = document.createElement("div");
  msgEl.textContent = messages.join(" ") + " ניתן להזין נתונים ידנית כגיבוי זמני:";
  banner.appendChild(msgEl);

  const fallbackRow = document.createElement("div");
  fallbackRow.className = "manual-fallback";

  if (!fxRate) {
    const label = document.createElement("label");
    label.textContent = "שער דולר-שקל:";
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.0001";
    input.placeholder = "לדוגמה 3.7";
    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.textContent = "עדכן שער";
    btn.onclick = () => {
      const val = parseFloat(input.value);
      if (val > 0) {
        fxRate = val;
        fxSource = "manual";
        render();
        refreshBanner();
      }
    };
    fallbackRow.appendChild(label);
    fallbackRow.appendChild(input);
    fallbackRow.appendChild(btn);
  }

  for (const holding of state.holdings) {
    if (prices[holding.ticker]) continue;
    const label = document.createElement("label");
    label.textContent = `מחיר ${holding.ticker} ($):`;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.placeholder = "לדוגמה 450";
    const btn = document.createElement("button");
    btn.className = "btn btn-small";
    btn.textContent = "עדכן מחיר";
    btn.onclick = () => {
      const val = parseFloat(input.value);
      if (val > 0) {
        prices[holding.ticker] = { usd: val, source: "manual" };
        render();
        refreshBanner();
      }
    };
    fallbackRow.appendChild(label);
    fallbackRow.appendChild(input);
    fallbackRow.appendChild(btn);
  }

  banner.appendChild(fallbackRow);
}

function refreshBanner() {
  const allPricesKnown = state.holdings.every((h) => prices[h.ticker]);
  const banner = document.getElementById("status-banner");
  if (allPricesKnown && fxRate) {
    banner.classList.add("hidden");
    banner.innerHTML = "";
  } else {
    renderStatusBanner(lastBannerMessages);
  }
}

// ---------- Calculations ----------

function computeHolding(holding) {
  const priceInfo = prices[holding.ticker];
  const currentPriceUSD = priceInfo ? priceInfo.usd : null;
  const currentValueILS =
    currentPriceUSD !== null && fxRate !== null
      ? holding.shares * currentPriceUSD * fxRate
      : null;
  let gainILS = null;
  let gainPercent = null;
  if (currentValueILS !== null && holding.costBasisILS) {
    gainILS = currentValueILS - holding.costBasisILS;
    gainPercent = (gainILS / holding.costBasisILS) * 100;
  }
  return { currentPriceUSD, currentValueILS, gainILS, gainPercent };
}

function filterRange(history, range) {
  if (range === "ALL") return history;
  const days = RANGE_DAYS[range];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const filtered = history.filter((r) => new Date(r.date) >= cutoff);
  return filtered.length >= 2 ? filtered : history.slice(-2);
}

// ---------- Rendering ----------

function render() {
  if (selectedTicker && !state.holdings.find((h) => h.ticker === selectedTicker)) {
    selectedTicker = state.holdings[0] ? state.holdings[0].ticker : null;
  }
  if (!selectedTicker && state.holdings[0]) {
    selectedTicker = state.holdings[0].ticker;
  }
  renderHero();
  renderHoldingsScroll();
  renderTickerOptions();
  renderDetailPanel();
}

function renderHero() {
  let totalValue = 0;
  let totalInvested = 0;
  let hasAnyValue = false;
  let hasAnyCostBasis = false;

  for (const holding of state.holdings) {
    const { currentValueILS } = computeHolding(holding);
    if (currentValueILS !== null) {
      totalValue += currentValueILS;
      hasAnyValue = true;
    }
    if (holding.costBasisILS) {
      totalInvested += holding.costBasisILS;
      hasAnyCostBasis = true;
    }
  }

  document.getElementById("hero-value").textContent = hasAnyValue ? ilsFormat(totalValue) : "—";

  const changeEl = document.getElementById("hero-change");
  if (hasAnyValue && hasAnyCostBasis) {
    const gain = totalValue - totalInvested;
    const percent = (gain / totalInvested) * 100;
    const arrow = gain >= 0 ? "▲" : "▼";
    changeEl.textContent = `${arrow} ${ilsFormat(gain)} (${percentFormat(percent)})`;
    changeEl.className = "hero-change " + (gain >= 0 ? "positive" : "negative");
  } else if (!hasAnyValue) {
    changeEl.textContent = "טוען מחירים...";
    changeEl.className = "hero-change";
  } else {
    changeEl.textContent = "יש להזין עלות רכישה לכל אחזקה";
    changeEl.className = "hero-change";
  }

  const metaEl = document.getElementById("last-updated");
  if (!state.lastUpdated) {
    metaEl.textContent = "";
  } else {
    const date = new Date(state.lastUpdated);
    metaEl.textContent = `עודכן לאחרונה: ${date.toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
}

function buildSparklinePoints(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const recent = history.slice(-30);
  const closes = recent.map((r) => r.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const step = 100 / (closes.length - 1);
  return closes
    .map((c, i) => {
      const x = (i * step).toFixed(2);
      const y = (28 - ((c - min) / range) * 26).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
}

function renderHoldingsScroll() {
  const container = document.getElementById("holdings-scroll");
  const template = document.getElementById("holding-mini-template");
  container.innerHTML = "";

  for (const holding of state.holdings) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".holding-mini");
    if (holding.ticker === selectedTicker) card.classList.add("active");

    const badge = node.querySelector(".ticker-badge");
    badge.classList.add(`palette-${paletteIndex(holding.ticker)}`);
    badge.textContent = holding.ticker.slice(0, 2);

    node.querySelector(".mini-ticker").textContent = holding.ticker;

    const { currentValueILS, gainPercent } = computeHolding(holding);
    node.querySelector(".mini-value").textContent =
      currentValueILS !== null ? ilsFormat(currentValueILS) : "טוען...";

    const changeEl = node.querySelector(".mini-change");
    if (gainPercent !== null) {
      changeEl.textContent = percentFormat(gainPercent);
      changeEl.className = "mini-change " + (gainPercent >= 0 ? "positive" : "negative");
    } else {
      changeEl.textContent = currentValueILS === null ? "טוען..." : "הזן עלות רכישה";
      changeEl.className = "mini-change";
    }

    const history = historyCache[holding.ticker];
    const spark = node.querySelector(".sparkline");
    const points = buildSparklinePoints(Array.isArray(history) ? history : null);
    if (points) {
      const closes = history.slice(-30).map((r) => r.close);
      const isUp = closes[closes.length - 1] >= closes[0];
      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", points);
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("stroke", isUp ? "#17c583" : "#ef4444");
      polyline.setAttribute("stroke-width", "2");
      spark.appendChild(polyline);
    }

    card.addEventListener("click", () => {
      selectedTicker = holding.ticker;
      renderHoldingsScroll();
      renderDetailPanel();
    });

    container.appendChild(node);
  }
}

function renderTickerOptions() {
  const datalist = document.getElementById("ticker-options");
  datalist.innerHTML = "";
  for (const holding of state.holdings) {
    const option = document.createElement("option");
    option.value = holding.ticker;
    datalist.appendChild(option);
  }
}

function renderDetailPanel() {
  const empty = document.getElementById("detail-empty");
  const content = document.getElementById("detail-content");

  const holding = state.holdings.find((h) => h.ticker === selectedTicker);
  if (!holding) {
    empty.classList.remove("hidden");
    content.style.display = "none";
    return;
  }
  empty.classList.add("hidden");
  content.style.display = "";

  document.getElementById("detail-ticker").textContent = holding.ticker;
  document.getElementById("detail-shares").textContent = `${holding.shares} מניות`;

  const { currentPriceUSD, currentValueILS, gainILS, gainPercent } = computeHolding(holding);
  document.getElementById("detail-price").textContent =
    currentPriceUSD !== null ? usdFormat(currentPriceUSD) : "טוען...";

  const history = historyCache[holding.ticker];
  const dailyEl = document.getElementById("detail-daily");
  if (Array.isArray(history) && history.length >= 2) {
    const last = history[history.length - 1].close;
    const prev = history[history.length - 2].close;
    const dailyPercent = ((last - prev) / prev) * 100;
    dailyEl.textContent = `${percentFormat(dailyPercent)} היום`;
    dailyEl.className = "detail-daily " + (dailyPercent >= 0 ? "positive" : "negative");
  } else {
    dailyEl.textContent = "";
    dailyEl.className = "detail-daily";
  }

  document.getElementById("stat-value").textContent =
    currentValueILS !== null ? ilsFormat(currentValueILS) : "—";
  document.getElementById("stat-cost").textContent = holding.costBasisILS
    ? ilsFormat(holding.costBasisILS)
    : "—";

  const gainEl = document.getElementById("stat-gain");
  const percentEl = document.getElementById("stat-percent");
  if (gainILS !== null) {
    gainEl.textContent = ilsFormat(gainILS);
    percentEl.textContent = percentFormat(gainPercent);
    gainEl.className = "stat-value " + (gainILS >= 0 ? "positive" : "negative");
    percentEl.className = "stat-value " + (gainPercent >= 0 ? "positive" : "negative");
  } else {
    gainEl.textContent = "—";
    percentEl.textContent = "—";
    gainEl.className = "stat-value";
    percentEl.className = "stat-value";
  }

  document.getElementById("cost-basis-input").value = holding.costBasisILS ?? "";

  document.querySelectorAll("#range-tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === currentRange);
  });

  renderChart(holding.ticker);
}

function renderChart(ticker) {
  const canvas = document.getElementById("price-chart");
  const errorEl = document.getElementById("chart-error");
  const rangeChangeEl = document.getElementById("range-change");
  const history = historyCache[ticker];

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (typeof Chart === "undefined") {
    canvas.style.display = "none";
    errorEl.textContent = "לא ניתן לטעון את ספריית הגרפים (בעיית רשת)";
    errorEl.classList.remove("hidden");
    rangeChangeEl.textContent = "";
    return;
  }

  if (history === "error" || !Array.isArray(history) || history.length < 2) {
    canvas.style.display = "none";
    errorEl.textContent = "לא ניתן לטעון גרף היסטורי כרגע";
    errorEl.classList.remove("hidden");
    rangeChangeEl.textContent = "";
    return;
  }

  canvas.style.display = "";
  errorEl.classList.add("hidden");

  const filtered = filterRange(history, currentRange);
  const first = filtered[0].close;
  const last = filtered[filtered.length - 1].close;
  const periodPercent = ((last - first) / first) * 100;
  const isUp = last >= first;

  rangeChangeEl.textContent = `שינוי בטווח: ${percentFormat(periodPercent)}`;
  rangeChangeEl.className = "range-change " + (isUp ? "positive" : "negative");

  const colorBase = isUp ? "23,197,131" : "239,68,68";
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 210);
  gradient.addColorStop(0, `rgba(${colorBase},0.28)`);
  gradient.addColorStop(1, `rgba(${colorBase},0)`);

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: filtered.map((r) => r.date),
      datasets: [
        {
          data: filtered.map((r) => r.close),
          borderColor: `rgb(${colorBase})`,
          backgroundColor: gradient,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: { display: false },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => usdFormat(item.parsed.y),
          },
        },
      },
      interaction: { mode: "nearest", intersect: false },
    },
  });
}

// ---------- Actions ----------

function handleAddPurchase(e) {
  e.preventDefault();
  const tickerInput = document.getElementById("ticker-input");
  const sharesInput = document.getElementById("shares-input");
  const paidInput = document.getElementById("paid-input");

  const ticker = tickerInput.value.trim().toUpperCase();
  const shares = parseFloat(sharesInput.value);
  const paid = parseFloat(paidInput.value);

  if (!ticker || !(shares > 0) || !(paid > 0)) return;

  let holding = state.holdings.find((h) => h.ticker === ticker);
  const isNew = !holding;
  if (holding) {
    holding.shares += shares;
    holding.costBasisILS = (holding.costBasisILS || 0) + paid;
  } else {
    holding = { ticker, shares, costBasisILS: paid };
    state.holdings.push(holding);
  }

  saveState();
  tickerInput.value = "";
  sharesInput.value = "";
  paidInput.value = "";
  selectedTicker = ticker;
  closeModal();

  render();
  refreshMarketData();
  if (isNew) refreshHistoryFor([ticker]).then(render);
}

function openModal() {
  document.getElementById("add-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("add-modal").classList.add("hidden");
}

document.getElementById("add-purchase-form").addEventListener("submit", handleAddPurchase);
document.getElementById("refresh-btn").addEventListener("click", refreshMarketData);
document.getElementById("fab-add").addEventListener("click", openModal);
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("add-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-modal") closeModal();
});

document.getElementById("range-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-range]");
  if (!btn) return;
  currentRange = btn.dataset.range;
  document.querySelectorAll("#range-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  if (selectedTicker) renderChart(selectedTicker);
});

document.getElementById("save-cost-btn").addEventListener("click", () => {
  const holding = state.holdings.find((h) => h.ticker === selectedTicker);
  if (!holding) return;
  const val = parseFloat(document.getElementById("cost-basis-input").value);
  holding.costBasisILS = val > 0 ? val : null;
  saveState();
  render();
});

document.getElementById("remove-holding-btn").addEventListener("click", () => {
  const holding = state.holdings.find((h) => h.ticker === selectedTicker);
  if (!holding) return;
  if (confirm(`למחוק את ${holding.ticker} מהתיק?`)) {
    state.holdings = state.holdings.filter((h) => h.ticker !== holding.ticker);
    delete prices[holding.ticker];
    delete historyCache[holding.ticker];
    selectedTicker = state.holdings[0] ? state.holdings[0].ticker : null;
    saveState();
    render();
  }
});

render();
refreshMarketData();

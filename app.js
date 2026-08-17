const STORAGE_KEY = "portfolio";

const DEFAULT_STATE = {
  holdings: [
    { ticker: "QQQ", shares: 33.25, costBasisILS: null },
    { ticker: "VOO", shares: 34.21, costBasisILS: null },
  ],
  lastUpdated: null,
};

const STOOQ_URL = (tickers) =>
  `https://stooq.com/q/l/?s=${tickers.map((t) => `${t.toLowerCase()}.us`).join(",")}&f=sd2t2ohlcv&h&e=csv`;
const FX_URL = "https://open.er-api.com/v6/latest/USD";

let state = loadState();
let prices = {}; // ticker -> { usd, source: 'api' | 'manual' }
let fxRate = null; // ILS per USD
let fxSource = null; // 'api' | 'manual'
let lastBannerMessages = [];

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

async function fetchPrices(tickers) {
  const res = await fetch(STOOQ_URL(tickers));
  if (!res.ok) throw new Error("stooq request failed");
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
  const res = await fetch(FX_URL);
  if (!res.ok) throw new Error("fx request failed");
  const data = await res.json();
  const rate = data?.rates?.ILS;
  if (!rate) throw new Error("ILS rate missing");
  return rate;
}

async function refreshMarketData() {
  const banner = document.getElementById("status-banner");
  const tickers = state.holdings.map((h) => h.ticker);
  let priceError = null;
  let fxError = null;

  if (tickers.length > 0) {
    try {
      const fetched = await fetchPrices(tickers);
      for (const ticker of tickers) {
        if (fetched[ticker] !== undefined) {
          prices[ticker] = { usd: fetched[ticker], source: "api" };
        } else if (!prices[ticker]) {
          priceError = "לא ניתן היה למצוא מחיר עבור אחד או יותר מהטיקרים.";
        }
      }
    } catch (e) {
      priceError = "שליפת מחירי המניות מהאינטרנט נכשלה (ייתכן חסימת רשת/CORS).";
    }
  }

  try {
    fxRate = await fetchFxRate();
    fxSource = "api";
  } catch (e) {
    fxError = "שליפת שער הדולר-שקל נכשלה (ייתכן חסימת רשת/CORS).";
  }

  lastBannerMessages = [priceError, fxError].filter(Boolean);
  if (lastBannerMessages.length > 0) {
    renderStatusBanner(lastBannerMessages);
  } else {
    banner.classList.add("hidden");
    banner.innerHTML = "";
  }

  state.lastUpdated = new Date().toISOString();
  saveState();
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

function render() {
  renderSummary();
  renderHoldings();
  renderTickerOptions();
  renderLastUpdated();
}

function renderSummary() {
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

  document.getElementById("summary-value").textContent = hasAnyValue
    ? ilsFormat(totalValue)
    : "—";
  document.getElementById("summary-invested").textContent = hasAnyCostBasis
    ? ilsFormat(totalInvested)
    : "—";

  const gainEl = document.getElementById("summary-gain");
  const percentEl = document.getElementById("summary-percent");

  if (hasAnyValue && hasAnyCostBasis) {
    const gain = totalValue - totalInvested;
    const percent = (gain / totalInvested) * 100;
    gainEl.textContent = ilsFormat(gain);
    percentEl.textContent = percentFormat(percent);
    gainEl.className = "summary-value " + (gain >= 0 ? "gain-positive" : "gain-negative");
    percentEl.className = "summary-value " + (percent >= 0 ? "gain-positive" : "gain-negative");
  } else {
    gainEl.textContent = "—";
    percentEl.textContent = "—";
    gainEl.className = "summary-value";
    percentEl.className = "summary-value";
  }
}

function renderHoldings() {
  const list = document.getElementById("holdings-list");
  const template = document.getElementById("holding-template");
  list.innerHTML = "";

  for (const holding of state.holdings) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".holding-card");
    node.querySelector(".holding-ticker").textContent = holding.ticker;
    node.querySelector(".holding-shares").textContent = holding.shares;

    const { currentPriceUSD, currentValueILS, gainILS, gainPercent } = computeHolding(holding);

    node.querySelector(".holding-price").textContent =
      currentPriceUSD !== null ? `${usdFormat(currentPriceUSD)}` : "טוען...";
    node.querySelector(".holding-value").textContent =
      currentValueILS !== null ? ilsFormat(currentValueILS) : "—";

    const costInput = node.querySelector(".cost-basis-input");
    costInput.value = holding.costBasisILS ?? "";

    const saveCostBtn = node.querySelector(".btn-save-cost");
    saveCostBtn.addEventListener("click", () => {
      const val = parseFloat(costInput.value);
      holding.costBasisILS = val > 0 ? val : null;
      saveState();
      render();
    });

    const gainEl = node.querySelector(".holding-gain");
    const warningEl = node.querySelector(".holding-warning");
    if (gainILS !== null) {
      gainEl.textContent = `${ilsFormat(gainILS)} (${percentFormat(gainPercent)})`;
      gainEl.className = "field-value holding-gain " + (gainILS >= 0 ? "gain-positive" : "gain-negative");
      warningEl.classList.add("hidden");
    } else {
      gainEl.textContent = "—";
      gainEl.className = "field-value holding-gain";
      if (!holding.costBasisILS) {
        warningEl.classList.remove("hidden");
      } else {
        warningEl.classList.add("hidden");
      }
    }

    node.querySelector(".btn-remove").addEventListener("click", () => {
      if (confirm(`למחוק את ${holding.ticker} מהתיק?`)) {
        state.holdings = state.holdings.filter((h) => h.ticker !== holding.ticker);
        delete prices[holding.ticker];
        saveState();
        render();
      }
    });

    list.appendChild(node);
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

function renderLastUpdated() {
  const el = document.getElementById("last-updated");
  if (!state.lastUpdated) {
    el.textContent = "";
    return;
  }
  const date = new Date(state.lastUpdated);
  el.textContent = `עודכן לאחרונה: ${date.toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

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

  render();
  refreshMarketData();
}

document.getElementById("add-purchase-form").addEventListener("submit", handleAddPurchase);
document.getElementById("refresh-btn").addEventListener("click", refreshMarketData);

render();
refreshMarketData();

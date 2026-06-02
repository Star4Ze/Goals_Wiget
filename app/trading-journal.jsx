const popularTickers = [
  { name: 'SBER', lot: 10, fullname: 'Сбербанк' },
  { name: 'SBERP', lot: 10, fullname: 'Сбербанк (преф.)' },
  { name: 'GAZP', lot: 10, fullname: 'Газпром' },
  { name: 'LKOH', lot: 1, fullname: 'Лукойл' },
  { name: 'ROSN', lot: 10, fullname: 'Роснефть' },
  { name: 'VTBR', lot: 10000, fullname: 'ВТБ' },
  { name: 'YNDX', lot: 1, fullname: 'Яндекс' },
  { name: 'GMKN', lot: 1, fullname: 'Норникель' },
  { name: 'AFLT', lot: 10, fullname: 'Аэрофлот' },
  { name: 'MGNT', lot: 1, fullname: 'Магнит' },
  { name: 'TATN', lot: 10, fullname: 'Татнефть' },
  { name: 'CHMF', lot: 1, fullname: 'Северсталь' },
  { name: 'ALRS', lot: 10, fullname: 'Алроса' },
  { name: 'NLMK', lot: 10, fullname: 'НЛМК' },
  { name: 'NVTK', lot: 10, fullname: 'Новатэк' },
  { name: 'PLZL', lot: 1, fullname: 'Полюс' },
  { name: 'HYDR', lot: 1000, fullname: 'РусГидро' },
  { name: 'FEES', lot: 10000, fullname: 'Россети' },
  { name: 'MTSS', lot: 10, fullname: 'МТС' },
  { name: 'MOEX', lot: 10, fullname: 'Московская Биржа' },
  { name: 'IRAO', lot: 100, fullname: 'Интер РАО' },
  { name: 'SGZH', lot: 100, fullname: 'Сегежа' },
  { name: 'PHOR', lot: 1, fullname: 'Фосагро' },
  { name: 'SELG', lot: 100, fullname: 'Селигдар' },
  { name: 'AQUA', lot: 1, fullname: 'Инарктика' },
  { name: 'BELU', lot: 1, fullname: 'НоваБев Групп (Белуга)' },
  { name: 'BSPB', lot: 10, fullname: 'Банк Санкт-Петербург' },
  { name: 'CBOM', lot: 100, fullname: 'МКБ' },
  { name: 'FLOT', lot: 10, fullname: 'Совкомфлот' },
  { name: 'MAGN', lot: 100, fullname: 'ММК' },
  { name: 'MSNG', lot: 1000, fullname: 'Мосэнерго' },
  { name: 'MTLR', lot: 10, fullname: 'Мечел' },
  { name: 'MTLRP', lot: 10, fullname: 'Мечел (преф.)' },
  { name: 'PIKK', lot: 10, fullname: 'ПИК' },
  { name: 'POSI', lot: 1, fullname: 'Группа Позитив' },
  { name: 'RASP', lot: 10, fullname: 'Распадская' },
  { name: 'RTKM', lot: 10, fullname: 'Ростелеком' },
  { name: 'SNGS', lot: 100, fullname: 'Сургутнефтегаз' },
  { name: 'SNGSP', lot: 100, fullname: 'Сургутнефтегаз (преф.)' },
  { name: 'SPBE', lot: 1, fullname: 'СПБ Биржа' },
  { name: 'UPRO', lot: 1000, fullname: 'Юнипро' },
  { name: 'VKCO', lot: 1, fullname: 'VK' },
  { name: 'TRNFP', lot: 1, fullname: 'Транснефть (преф.)' }
];

const { useState, useEffect, useRef } = React;

// Helper to format currency
const formatRub = (num) => {
  return Math.round(num).toLocaleString('ru-RU') + ' ₽';
};

// Date helpers
const getWeekNumber = (d) => {
  d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return weekNo;
};

const getStartAndEndOfWeek = (date) => {
  const day = date.getDay() || 7;
  const start = new Date(date);
  start.setDate(date.getDate() - day + 1);
  const end = new Date(date);
  end.setDate(date.getDate() - day + 7);
  
  const formatDateStr = (d) => {
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
  };
  return `${formatDateStr(start)} - ${formatDateStr(end)}`;
};

const getDayNameRU = (date) => {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  return days[date.getDay()];
};

const getMonthNameRU = (date) => {
  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  return months[date.getMonth()];
};

// Autocomplete Component
function TickerAutocomplete({ value, onChange, onSelectLot }) {
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleInputChange = (e) => {
    const val = e.target.value.toUpperCase();
    onChange(val);
    if (val.trim()) {
      const filtered = popularTickers.filter(t => 
        t.name.includes(val) || t.fullname.toLowerCase().includes(val.toLowerCase())
      );
      setSuggestions(filtered);
      setIsOpen(true);
    } else {
      setSuggestions([]);
      setIsOpen(false);
    }
  };

  const handleSelect = (ticker) => {
    onChange(ticker.name);
    onSelectLot(ticker.lot);
    setIsOpen(false);
  };

  return (
    <div ref={wrapperRef} className="autocomplete-wrapper">
      <input 
        type="text" 
        value={value} 
        onChange={handleInputChange} 
        onFocus={() => { if (value) setIsOpen(true); }}
        placeholder="Напр. SBER" 
        className="trade-input text-upper"
        required
      />
      {isOpen && suggestions.length > 0 && (
        <ul className="autocomplete-list">
          {suggestions.map(s => (
            <li key={s.name} onClick={() => handleSelect(s)}>
              <span className="ticker-code">{s.name}</span>
              <span className="ticker-name">{s.fullname} (лот: {s.lot})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Screenshot Drop & Paste Zone Component
function ImageZone({ label, imageUrl, onImageUploaded, tempId }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const processImageBase64 = async (base64) => {
    setIsLoading(true);
    if (window.electronAPI && window.electronAPI.saveTradeScreenshot) {
      const res = await window.electronAPI.saveTradeScreenshot(tempId, base64, label === 'Вход' ? 'entry' : 'exit');
      if (res.success) {
        onImageUploaded(res.url);
      } else {
        alert('Ошибка сохранения картинки: ' + res.error);
      }
    }
    setIsLoading(false);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const blob = items[i].getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          processImageBase64(event.target.result);
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        processImageBase64(event.target.result);
      };
      reader.readAsDataURL(files[0]);
    }
  };

  return (
    <div 
      className={`image-zone ${isDragOver ? 'dragover' : ''} ${imageUrl ? 'has-image' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
      tabIndex={0}
      title="Кликните и нажмите Ctrl+V для вставки из буфера или перетащите файл сюда"
    >
      {isLoading ? (
        <div className="loader">Сохранение...</div>
      ) : imageUrl ? (
        <div className="preview-container">
          <img src={imageUrl} alt={label} className="preview-img" />
          <div className="preview-overlay">
            <span>Изменить (Ctrl+V / Перетащить)</span>
          </div>
        </div>
      ) : (
        <div className="empty-zone-content">
          <span className="zone-icon">📷</span>
          <span className="zone-label">{label}</span>
          <span className="zone-sub">Перетащите или Ctrl+V</span>
        </div>
      )}
    </div>
  );
}

// Fullscreen Modal for Screenshots
function ImageFullscreenModal({ url, onClose }) {
  if (!url) return null;
  return (
    <div className="fullscreen-overlay" onClick={onClose}>
      <button className="fullscreen-close" onClick={onClose}>✕</button>
      <img src={url} alt="Скриншот сделки" className="fullscreen-img" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

window.TradingJournalApp = function() {
  const [data, setData] = useState({ deposit: 100000, settings: { maxRiskPerTradePercent: 2, maxRiskPerMonthPercent: 6 }, trades: [] });
  const [ticker, setTicker] = useState('');
  const [lotSize, setLotSize] = useState(1);
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [noteEntry, setNoteEntry] = useState('');
  const [screenshotEntry, setScreenshotEntry] = useState('');
  
  // Generating a persistent temp ID for unsaved trade assets
  const [tempTradeId, setTempTradeId] = useState(() => Date.now().toString());

  // Edit risk settings states
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [editDeposit, setEditDeposit] = useState('100000');
  const [editRiskTrade, setEditRiskTrade] = useState('2');
  const [editRiskMonth, setEditRiskMonth] = useState('6');

  // Close trade details modal states
  const [closingTradeId, setClosingTradeId] = useState(null);
  const [exitPrice, setExitPrice] = useState('');
  const [noteExit, setNoteExit] = useState('');
  const [screenshotExit, setScreenshotExit] = useState('');

  // Accordion collapsed state: store keys of open sections
  const [expandedSections, setExpandedSections] = useState({});

  // Fullscreen image url
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState(null);

  // Initialize data from main Electron process
  useEffect(() => {
    async function loadData() {
      if (window.electronAPI && window.electronAPI.getTradingData) {
        const loaded = await window.electronAPI.getTradingData();
        setData(loaded);
        setEditDeposit(loaded.deposit.toString());
        setEditRiskTrade(loaded.settings.maxRiskPerTradePercent.toString());
        setEditRiskMonth(loaded.settings.maxRiskPerMonthPercent.toString());
        
        // Auto-expand current Month/Week by default
        const today = new Date();
        const monthKey = `${getMonthNameRU(today)} ${today.getFullYear()}`;
        const weekKey = `Неделя ${getWeekNumber(today)} (${getStartAndEndOfWeek(today)})`;
        setExpandedSections({
          [monthKey]: true,
          [`${monthKey}_${weekKey}`]: true
        });
      }
    }
    loadData();
  }, []);

  // Write changes back to trades.json
  const saveData = async (newData) => {
    setData(newData);
    if (window.electronAPI && window.electronAPI.saveTradingData) {
      await window.electronAPI.saveTradingData(newData);
    }
  };

  // Close current Electron window
  const handleCloseWindow = () => {
    if (window.electronAPI && window.electronAPI.closeWindow) {
      window.electronAPI.closeWindow();
    }
  };

  // Calculated variables for new trade live math
  const calculatedRiskAmt = entryPrice && stopLoss ? Math.abs(parseFloat(entryPrice) - parseFloat(stopLoss)) : 0;
  const maxRiskPerTradeAmount = (data.deposit * data.settings.maxRiskPerTradePercent) / 100;
  const calculatedMaxLots = calculatedRiskAmt && lotSize 
    ? Math.floor(maxRiskPerTradeAmount / (calculatedRiskAmt * lotSize)) 
    : 0;
  const totalPositionCost = entryPrice && calculatedMaxLots 
    ? calculatedMaxLots * lotSize * parseFloat(entryPrice) 
    : 0;

  // Monthly stats calculations
  const today = new Date();
  const currentMonthTrades = data.trades.filter(t => {
    const tradeDate = new Date(t.entryTime);
    return tradeDate.getMonth() === today.getMonth() && tradeDate.getFullYear() === today.getFullYear();
  });

  const activeTradesCount = data.trades.filter(t => t.status === 'active').length;

  const monthlyRealizedPnL = currentMonthTrades.reduce((sum, t) => {
    if (t.status === 'closed' && t.profitAmount) {
      return sum + t.profitAmount;
    }
    return sum;
  }, 0);

  const monthlyActiveRisk = data.trades
    .filter(t => t.status === 'active')
    .reduce((sum, t) => {
      const riskPerShare = Math.abs(t.entryPrice - t.stopLoss);
      return sum + (riskPerShare * t.lots * (t.lotSize || 1));
    }, 0);

  const totalMonthlyRiskUsedAmount = Math.max(0, -monthlyRealizedPnL) + monthlyActiveRisk;
  const maxMonthlyLossAmount = (data.deposit * data.settings.maxRiskPerMonthPercent) / 100;
  const remainingMonthlyRiskAmount = maxMonthlyLossAmount - totalMonthlyRiskUsedAmount;
  const monthlyRiskPercent = maxMonthlyLossAmount > 0 
    ? Math.min(100, (totalMonthlyRiskUsedAmount / maxMonthlyLossAmount) * 100) 
    : 0;

  // Save changes to settings
  const handleSaveSettings = async () => {
    const newData = {
      ...data,
      deposit: parseFloat(editDeposit) || 100000,
      settings: {
        maxRiskPerTradePercent: parseFloat(editRiskTrade) || 2,
        maxRiskPerMonthPercent: parseFloat(editRiskMonth) || 6
      }
    };
    await saveData(newData);
    setIsEditingSettings(false);
  };

  // Add new trade
  const handleAddTrade = async (e) => {
    e.preventDefault();
    if (!ticker.trim() || !entryPrice || !stopLoss || !takeProfit) {
      alert('Заполните обязательные поля');
      return;
    }

    if (calculatedMaxLots <= 0) {
      alert('Риск-менеджер: Расчетное число лотов равно 0. Сделка отклонена из-за недостаточного капитала или слишком далекого стоп-лосса.');
      return;
    }

    // Checking if risk violates monthly rules
    const plannedTradeRisk = calculatedRiskAmt * calculatedMaxLots * lotSize;
    if (plannedTradeRisk > remainingMonthlyRiskAmount) {
      const proceed = confirm(`Предупреждение риск-менеджера:\nЭта сделка добавит риск в ${formatRub(plannedTradeRisk)}, что превышает оставшийся лимит потерь на месяц (${formatRub(remainingMonthlyRiskAmount)}).\nВы уверены, что хотите открыть сделку вопреки риск-менеджменту?`);
      if (!proceed) return;
    }

    const newTrade = {
      id: tempTradeId,
      ticker: ticker.toUpperCase(),
      lotSize: lotSize,
      entryPrice: parseFloat(entryPrice),
      stopLoss: parseFloat(stopLoss),
      takeProfit: parseFloat(takeProfit),
      lots: calculatedMaxLots,
      entryTime: new Date().toISOString(),
      exitTime: null,
      exitPrice: null,
      status: 'active',
      screenshotEntry: screenshotEntry,
      screenshotExit: '',
      noteEntry: noteEntry,
      noteExit: '',
      profitAmount: null,
      profitPercent: null
    };

    const newData = {
      ...data,
      trades: [newTrade, ...data.trades]
    };

    await saveData(newData);

    // Reset inputs
    setTicker('');
    setLotSize(1);
    setEntryPrice('');
    setStopLoss('');
    setTakeProfit('');
    setNoteEntry('');
    setScreenshotEntry('');
    setTempTradeId(Date.now().toString());
  };

  // Opening the close trade form modal
  const handleOpenCloseTradeModal = (trade) => {
    setClosingTradeId(trade.id);
    setExitPrice(trade.entryPrice.toString());
    setNoteExit('');
    setScreenshotExit('');
  };

  // Submitting the closing trade form
  const handleCloseTradeSubmit = async (e) => {
    e.preventDefault();
    const trade = data.trades.find(t => t.id === closingTradeId);
    if (!trade) return;

    const exitVal = parseFloat(exitPrice);
    if (isNaN(exitVal)) {
      alert('Укажите корректную цену закрытия');
      return;
    }

    // Calculate P&L: Assuming Long trade for simplistic formula.
    // P&L per share = exitPrice - entryPrice.
    // If stopLoss is greater than entryPrice, it is a Short trade.
    const isShort = trade.stopLoss > trade.entryPrice;
    const diff = exitVal - trade.entryPrice;
    const pnlPerShare = isShort ? -diff : diff;
    const totalPnl = pnlPerShare * trade.lots * trade.lotSize;
    const pnlPercent = (pnlPerShare / trade.entryPrice) * 100;

    const updatedTrades = data.trades.map(t => {
      if (t.id === closingTradeId) {
        return {
          ...t,
          status: 'closed',
          exitPrice: exitVal,
          exitTime: new Date().toISOString(),
          noteExit: noteExit,
          screenshotExit: screenshotExit,
          profitAmount: totalPnl,
          profitPercent: pnlPercent
        };
      }
      return t;
    });

    await saveData({
      ...data,
      trades: updatedTrades
    });

    setClosingTradeId(null);
  };

  // Delete trade completely
  const handleDeleteTrade = async (id) => {
    if (!confirm('Вы действительно хотите безвозвратно удалить эту сделку из журнала?')) return;
    const filtered = data.trades.filter(t => t.id !== id);
    await saveData({
      ...data,
      trades: filtered
    });
  };

  // Collapsible accordion controller
  const toggleSection = (key) => {
    setExpandedSections(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  // Structure trades hierarchically: Month -> Week -> Day -> Trades list
  const getGroupedTrades = () => {
    const groups = {};
    
    data.trades.forEach(t => {
      const date = new Date(t.entryTime);
      const monthKey = `${getMonthNameRU(date)} ${date.getFullYear()}`;
      const weekKey = `Неделя ${getWeekNumber(date)} (${getStartAndEndOfWeek(date)})`;
      const dayKey = `${getDayNameRU(date)}, ${date.getDate()} ${getMonthNameRU(date).toLowerCase().replace(/ь$/, 'я').replace(/т$/, 'та').replace(/й$/, 'я')}`; // basic RU date decline
      
      if (!groups[monthKey]) groups[monthKey] = {};
      if (!groups[monthKey][weekKey]) groups[monthKey][weekKey] = {};
      if (!groups[monthKey][weekKey][dayKey]) groups[monthKey][weekKey][dayKey] = [];
      
      groups[monthKey][weekKey][dayKey].push(t);
    });

    return groups;
  };

  const groupedTrades = getGroupedTrades();

  return (
    <div className="window-container">
      {/* Title bar */}
      <div className="window-header">
        <div className="window-title">
          <span>📈</span>
          <h1>TradeLog — Журнал торговых сделок</h1>
        </div>
        <button className="window-close-btn" onClick={handleCloseWindow} title="Закрыть">✕</button>
      </div>

      <div className="window-body">
        {/* Top risk management & stats dashboard */}
        <div className="dashboard-grid">
          <div className="dashboard-card stat-deposit">
            <div className="card-lbl">Сумма депозита</div>
            {isEditingSettings ? (
              <div className="settings-inline-edit">
                <input 
                  type="number" 
                  value={editDeposit} 
                  onChange={(e) => setEditDeposit(e.target.value)} 
                  className="settings-field-input"
                />
                <button onClick={handleSaveSettings} className="settings-save-btn">✓</button>
              </div>
            ) : (
              <div className="card-val-row">
                <div className="card-val">{formatRub(data.deposit)}</div>
                <button onClick={() => setIsEditingSettings(true)} className="settings-pencil-btn" title="Редактировать">⚙️</button>
              </div>
            )}
          </div>

          <div className="dashboard-card">
            <div className="card-lbl">Риск на сделку (лимит)</div>
            {isEditingSettings ? (
              <div className="settings-inline-edit">
                <input 
                  type="number" 
                  step="0.5"
                  value={editRiskTrade} 
                  onChange={(e) => setEditRiskTrade(e.target.value)} 
                  className="settings-field-input"
                  style={{ width: '60px' }}
                />
                <span className="unit-percent">%</span>
              </div>
            ) : (
              <div className="card-val">{data.settings.maxRiskPerTradePercent}% <span className="sub-val">({formatRub(maxRiskPerTradeAmount)})</span></div>
            )}
          </div>

          <div className="dashboard-card">
            <div className="card-lbl">Задействованный риск в месяце</div>
            <div className="card-val">
              {formatRub(totalMonthlyRiskUsedAmount)} 
              <span className="sub-val"> из {formatRub(maxMonthlyLossAmount)} ({data.settings.maxRiskPerMonthPercent}%)</span>
            </div>
            <div className="risk-progress-bar">
              <div 
                className={`risk-progress-fill ${monthlyRiskPercent >= 90 ? 'critical' : monthlyRiskPercent >= 70 ? 'warning' : ''}`}
                style={{ width: `${monthlyRiskPercent}%` }}
              ></div>
            </div>
          </div>

          <div className="dashboard-card">
            <div className="card-lbl">Лимит потерь (остаток)</div>
            <div className={`card-val ${remainingMonthlyRiskAmount <= 0 ? 'critical-text' : remainingMonthlyRiskAmount < maxRiskPerTradeAmount ? 'warning-text' : 'success-text'}`}>
              {formatRub(remainingMonthlyRiskAmount)}
            </div>
          </div>
        </div>

        <div className="main-content-layout">
          {/* Left panel: Add new trade */}
          <div className="form-panel-column">
            <h2 className="panel-section-title">💼 Новая сделка</h2>
            
            <form onSubmit={handleAddTrade} className="add-trade-form">
              <div className="form-row">
                <div className="form-group flex-2">
                  <label>Ассет (тикер)</label>
                  <TickerAutocomplete 
                    value={ticker} 
                    onChange={setTicker} 
                    onSelectLot={setLotSize}
                  />
                </div>
                <div className="form-group flex-1">
                  <label>Лотность</label>
                  <input 
                    type="number" 
                    value={lotSize} 
                    onChange={(e) => setLotSize(parseInt(e.target.value) || 1)} 
                    placeholder="1" 
                    className="trade-input"
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Вход (цена)</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={entryPrice} 
                    onChange={(e) => setEntryPrice(e.target.value)} 
                    placeholder="0.00" 
                    className="trade-input"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Стоп-лосс</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={stopLoss} 
                    onChange={(e) => setStopLoss(e.target.value)} 
                    placeholder="0.00" 
                    className="trade-input"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Тейк-профит</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={takeProfit} 
                    onChange={(e) => setTakeProfit(e.target.value)} 
                    placeholder="0.00" 
                    className="trade-input"
                    required
                  />
                </div>
              </div>

              {/* Calculator output section */}
              {entryPrice && stopLoss ? (
                <div className="calc-summary-box">
                  <div className="calc-summary-row">
                    <span>Расчетный риск на акцию:</span>
                    <span className="calc-summary-val">{formatRub(calculatedRiskAmt)}</span>
                  </div>
                  <div className="calc-summary-row">
                    <span>Максимальный объем сделки:</span>
                    <span className="calc-summary-val highlighted-lots">{calculatedMaxLots} лотов <span className="sub">({calculatedMaxLots * lotSize} акций)</span></span>
                  </div>
                  <div className="calc-summary-row">
                    <span>Общая стоимость позиции:</span>
                    <span className="calc-summary-val">{formatRub(totalPositionCost)}</span>
                  </div>
                  <div className="calc-summary-row">
                    <span>Риск капитала на сделку:</span>
                    <span className="calc-summary-val danger-text">
                      {formatRub(calculatedRiskAmt * calculatedMaxLots * lotSize)} 
                      &nbsp;({((calculatedRiskAmt * calculatedMaxLots * lotSize) / data.deposit * 100).toFixed(2)}%)
                    </span>
                  </div>
                </div>
              ) : null}

              <div className="form-group">
                <label>Анализ входа / Состояние / Мысли</label>
                <textarea 
                  value={noteEntry} 
                  onChange={(e) => setNoteEntry(e.target.value)} 
                  placeholder="В каком эмоциональном состоянии вхожу? Какие паттерны вижу на графике?" 
                  className="trade-textarea"
                ></textarea>
              </div>

              <div className="screenshot-uploads">
                <ImageZone 
                  label="Вход" 
                  imageUrl={screenshotEntry} 
                  onImageUploaded={setScreenshotEntry}
                  tempId={tempTradeId}
                />
              </div>

              <button type="submit" className="submit-trade-btn">
                🚀 Открыть сделку
              </button>
            </form>
          </div>

          {/* Right panel: trades list grouped in Accordions */}
          <div className="list-panel-column">
            <div className="list-header-row">
              <h2 className="panel-section-title">📂 История сделок</h2>
              <span className="active-badge-indicator">{activeTradesCount} активных</span>
            </div>

            <div className="history-accordion-container">
              {Object.keys(groupedTrades).length === 0 ? (
                <div className="no-trades-card">
                  <span className="no-trades-icon">📖</span>
                  <p>У вас еще нет сделок. Заполните форму слева, чтобы открыть первую сделку.</p>
                </div>
              ) : (
                Object.keys(groupedTrades).map(monthKey => {
                  const isMonthExpanded = !!expandedSections[monthKey];
                  const weeks = groupedTrades[monthKey];
                  
                  return (
                    <div key={monthKey} className="accordion-card month-group">
                      <div className="accordion-header month-header" onClick={() => toggleSection(monthKey)}>
                        <span className="accordion-toggle-arrow">{isMonthExpanded ? '▼' : '▶'}</span>
                        <span className="month-name">{monthKey}</span>
                      </div>

                      {isMonthExpanded && (
                        <div className="accordion-content month-content">
                          {Object.keys(weeks).map(weekKey => {
                            const fullWeekKey = `${monthKey}_${weekKey}`;
                            const isWeekExpanded = !!expandedSections[fullWeekKey];
                            const days = weeks[weekKey];

                            return (
                              <div key={weekKey} className="accordion-card week-group">
                                <div className="accordion-header week-header" onClick={() => toggleSection(fullWeekKey)}>
                                  <span className="accordion-toggle-arrow">{isWeekExpanded ? '▼' : '▶'}</span>
                                  <span className="week-name">{weekKey}</span>
                                </div>

                                {isWeekExpanded && (
                                  <div className="accordion-content week-content">
                                    {Object.keys(days).map(dayKey => {
                                      const trades = days[dayKey];

                                      return (
                                        <div key={dayKey} className="day-group">
                                          <div className="day-header-lbl">{dayKey}</div>
                                          
                                          <div className="trades-list-container">
                                            {trades.map(t => {
                                              const isTradeActive = t.status === 'active';
                                              const formattedDate = new Date(t.entryTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                              const endFormattedDate = t.exitTime 
                                                ? new Date(t.exitTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) 
                                                : '';

                                              return (
                                                <div 
                                                  key={t.id} 
                                                  className={`trade-item-card ${isTradeActive ? 'active-trade' : t.profitAmount >= 0 ? 'win-trade' : 'loss-trade'}`}
                                                >
                                                  <div className="trade-card-top-row">
                                                    <div className="trade-meta-left">
                                                      <span className="trade-item-ticker">{t.ticker}</span>
                                                      <span className="trade-item-lots">{t.lots} лот. ({t.lots * (t.lotSize || 1)} шт)</span>
                                                      <span className="trade-item-time">🕒 {formattedDate} {t.exitTime ? ` - ${endFormattedDate}` : ''}</span>
                                                    </div>
                                                    
                                                    <div className="trade-meta-right">
                                                      {isTradeActive ? (
                                                        <span className="active-trade-label">АКТИВНА</span>
                                                      ) : (
                                                        <span className={`pnl-label ${t.profitAmount >= 0 ? 'pnl-win' : 'pnl-loss'}`}>
                                                          {t.profitAmount >= 0 ? '+' : ''}{formatRub(t.profitAmount)} ({t.profitPercent >= 0 ? '+' : ''}{t.profitPercent.toFixed(2)}%)
                                                        </span>
                                                      )}
                                                      <button onClick={() => handleDeleteTrade(t.id)} className="delete-trade-btn" title="Удалить сделку">🗑️</button>
                                                    </div>
                                                  </div>

                                                  <div className="trade-card-details-grid">
                                                    <div className="trade-prices-col">
                                                      <div><strong>Вход:</strong> {t.entryPrice} ₽</div>
                                                      <div><strong>Стоп:</strong> {t.stopLoss} ₽</div>
                                                      <div><strong>Цель:</strong> {t.takeProfit} ₽</div>
                                                      {t.exitPrice && <div><strong>Выход:</strong> {t.exitPrice} ₽</div>}
                                                    </div>

                                                    <div className="trade-notes-col">
                                                      {t.noteEntry && (
                                                        <div className="note-bubble">
                                                          <span className="note-lbl">Вход:</span> "{t.noteEntry}"
                                                        </div>
                                                      )}
                                                      {t.noteExit && (
                                                        <div className="note-bubble">
                                                          <span className="note-lbl">Выход:</span> "{t.noteExit}"
                                                        </div>
                                                      )}
                                                    </div>

                                                    <div className="trade-thumbs-col">
                                                      {t.screenshotEntry && (
                                                        <img 
                                                          src={t.screenshotEntry} 
                                                          alt="Вход" 
                                                          className="trade-thumbnail-img" 
                                                          onClick={() => setFullscreenImageUrl(t.screenshotEntry)}
                                                          title="Кликните для увеличения"
                                                        />
                                                      )}
                                                      {t.screenshotExit ? (
                                                        <img 
                                                          src={t.screenshotExit} 
                                                          alt="Выход" 
                                                          className="trade-thumbnail-img" 
                                                          onClick={() => setFullscreenImageUrl(t.screenshotExit)}
                                                          title="Кликните для увеличения"
                                                        />
                                                      ) : isTradeActive ? (
                                                        <div className="empty-thumb-placeholder">В процессе</div>
                                                      ) : null}
                                                    </div>
                                                  </div>

                                                  {isTradeActive && (
                                                    <div className="active-trade-actions">
                                                      <button 
                                                        onClick={() => handleOpenCloseTradeModal(t)} 
                                                        className="close-trade-action-btn"
                                                      >
                                                        🔒 Закрыть сделку (зафиксировать результат)
                                                      </button>
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Modal: Close Trade Form */}
      {closingTradeId && (
        <div className="modal-overlay-trade">
          <div className="modal-content-trade">
            <div className="modal-header-trade">
              <h3>Закрытие сделки</h3>
              <button onClick={() => setClosingTradeId(null)} className="modal-close-trade">✕</button>
            </div>
            
            <form onSubmit={handleCloseTradeSubmit} className="close-trade-form">
              <div className="form-group">
                <label>Цена выхода (фактическая)</label>
                <input 
                  type="number" 
                  step="0.0001"
                  value={exitPrice} 
                  onChange={(e) => setExitPrice(e.target.value)} 
                  className="trade-input"
                  required
                />
              </div>

              <div className="form-group">
                <label>Анализ выхода / Состояние / Уроки</label>
                <textarea 
                  value={noteExit} 
                  onChange={(e) => setNoteExit(e.target.value)} 
                  placeholder="Соответствовал ли выход моей стратегии? Каково эмоциональное состояние?" 
                  className="trade-textarea"
                ></textarea>
              </div>

              <div className="form-group">
                <label>Скриншот выхода</label>
                <ImageZone 
                  label="Выход" 
                  imageUrl={screenshotExit} 
                  onImageUploaded={setScreenshotExit}
                  tempId={closingTradeId}
                />
              </div>

              <div className="modal-footer-trade">
                <button type="button" onClick={() => setClosingTradeId(null)} className="cancel-trade-btn">Отмена</button>
                <button type="submit" className="save-trade-btn">Сохранить и зафиксировать</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Fullscreen Screenshot Overlay Modal */}
      {fullscreenImageUrl && (
        <ImageFullscreenModal 
          url={fullscreenImageUrl} 
          onClose={() => setFullscreenImageUrl(null)} 
        />
      )}
    </div>
  );
};

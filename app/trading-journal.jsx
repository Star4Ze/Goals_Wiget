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

const colorOptions = [
  { name: 'Mint', primary: '#3ddc84', hover: '#5beb9b' },
  { name: 'Purple', primary: '#a186f1', hover: '#b399ff' },
  { name: 'Sky Blue', primary: '#4db8ff', hover: '#70c7ff' },
  { name: 'Pink', primary: '#ff75b5', hover: '#ff94c7' },
  { name: 'Sunset Orange', primary: '#ff8f59', hover: '#ffa57a' }
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
function TickerAutocomplete({ value, onChange, onSelectLot, tickersList }) {
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [favorites, setFavorites] = useState(() => {
    try {
      const saved = localStorage.getItem('trade_favorites');
      return saved ? JSON.parse(saved) : ['SBER', 'GAZP', 'LKOH'];
    } catch (e) {
      return [];
    }
  });
  const wrapperRef = useRef(null);

  useEffect(() => {
    localStorage.setItem('trade_favorites', JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    function handleClickOutside(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getFilteredSuggestions = (val) => {
    const searchVal = val.toUpperCase().trim();
    if (!searchVal) {
      // If search is empty, show favorited tickers
      return (tickersList || []).filter(t => favorites.includes(t.name));
    }
    const matching = (tickersList || []).filter(t => 
      t.name.includes(searchVal) || t.fullname.toLowerCase().includes(searchVal.toLowerCase())
    );
    // Sort so favorited tickers are shown first
    return matching.sort((a, b) => {
      const aFav = favorites.includes(a.name) ? 1 : 0;
      const bFav = favorites.includes(b.name) ? 1 : 0;
      return bFav - aFav;
    });
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    onChange(val);
    const filtered = getFilteredSuggestions(val);
    setSuggestions(filtered);
    setIsOpen(true);
  };

  const handleFocus = () => {
    const filtered = getFilteredSuggestions(value);
    setSuggestions(filtered);
    setIsOpen(true);
  };

  const handleSelect = (ticker) => {
    onChange(ticker.name);
    onSelectLot(ticker.lot);
    setIsOpen(false);
  };

  const toggleFavorite = (e, tickerName) => {
    e.stopPropagation(); // Prevent trigger selection when clicking the star
    setFavorites(prev => {
      const updated = prev.includes(tickerName)
        ? prev.filter(name => name !== tickerName)
        : [...prev, tickerName];
      return updated;
    });
  };

  // Re-run suggestion filter when favorites or tickers list change
  useEffect(() => {
    if (isOpen) {
      setSuggestions(getFilteredSuggestions(value));
    }
  }, [favorites, tickersList, value]);

  return (
    <div ref={wrapperRef} className="autocomplete-wrapper">
      <input 
        type="text" 
        value={value} 
        onChange={handleInputChange} 
        onFocus={handleFocus}
        placeholder="Напр. SBER" 
        className="trade-input text-upper"
        required
      />
      {isOpen && suggestions.length > 0 && (
        <ul className="autocomplete-list">
          {suggestions.map(s => {
            const isFav = favorites.includes(s.name);
            return (
              <li key={s.name} onClick={() => handleSelect(s)}>
                <div className="ticker-code-col">
                  <span className="ticker-code">{s.name}</span>
                  <span 
                    className={`star-btn ${isFav ? 'active' : ''}`} 
                    onClick={(e) => toggleFavorite(e, s.name)}
                    title={isFav ? "Убрать из избранного" : "Добавить в избранное"}
                  >
                    {isFav ? '★' : '☆'}
                  </span>
                </div>
                <span className="ticker-name">{s.fullname} (лот: {s.lot})</span>
              </li>
            );
          })}
        </ul>
      )}
      {isOpen && value.trim() === '' && suggestions.length === 0 && (
        <ul className="autocomplete-list">
          <li className="text-center text-muted" style={{ padding: '8px 10px', fontSize: '10.5px' }}>
            Нет избранных тикеров. Начните вводить тикер и нажмите ☆, чтобы добавить в избранное.
          </li>
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
  
  // Views states: 'trades' | 'analytics'
  const [currentView, setCurrentView] = useState('trades');

  // Custom visual states
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [windowOpacity, setWindowOpacity] = useState(() => parseFloat(localStorage.getItem('trade_opacity') || '0.9'));
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('trade_accent') || '#3ddc84');
  const [accentHover, setAccentHover] = useState(() => localStorage.getItem('trade_accent_hover') || '#5beb9b');

  // Add trade form overlay
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [ticker, setTicker] = useState('');
  const [lotSize, setLotSize] = useState(1);
  const [multiplier, setMultiplier] = useState(1);
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [noteEntry, setNoteEntry] = useState('');
  const [screenshotEntry, setScreenshotEntry] = useState('');
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

  // T-Bank Token Configuration states
  const [tbankToken, setTbankToken] = useState('');
  const [isTokenSaved, setIsTokenSaved] = useState(false);

  // Load T-Bank token from config on mount
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getTBankToken) {
      window.electronAPI.getTBankToken().then(token => {
        setTbankToken(token || '');
      });
    }
  }, []);

  const handleSaveTbankToken = async () => {
    if (window.electronAPI && window.electronAPI.saveTBankToken) {
      const success = await window.electronAPI.saveTBankToken(tbankToken);
      if (success) {
        setIsTokenSaved(true);
        setTimeout(() => setIsTokenSaved(false), 1500);
        
        // Auto trigger reload of tickers 3 seconds after save
        if (window.electronAPI.getSyncedTickers) {
          setTimeout(() => {
            window.electronAPI.getSyncedTickers().then(synced => {
              if (synced && synced.length > 0) {
                setTickersList(synced);
              }
            });
          }, 3000);
        }
      }
    }
  };

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');

  const handleSyncTickers = async () => {
    if (!tbankToken.trim()) {
      alert('Сначала введите и сохраните токен API');
      return;
    }
    setIsSyncing(true);
    setSyncStatus('Синхронизация...');
    try {
      if (window.electronAPI && window.electronAPI.syncTBankTickers) {
        const res = await window.electronAPI.syncTBankTickers();
        if (res.success) {
          setSyncStatus(`Успешно: ${res.count} тикеров`);
          if (window.electronAPI.getSyncedTickers) {
            const synced = await window.electronAPI.getSyncedTickers();
            if (synced && synced.length > 0) {
              setTickersList(synced);
            }
          }
        } else {
          setSyncStatus(`Ошибка: ${res.error}`);
        }
      } else {
        setSyncStatus('API недоступно');
      }
    } catch (err) {
      setSyncStatus(`Ошибка: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // Dynamic Tickers List State
  const [tickersList, setTickersList] = useState(popularTickers);

  // Load synced tickers from local data directory on mount
  useEffect(() => {
    if (window.electronAPI && window.electronAPI.getSyncedTickers) {
      window.electronAPI.getSyncedTickers().then(synced => {
        if (synced && synced.length > 0) {
          setTickersList(synced);
        }
      });
    }
  }, []);

  // Watch ticker changes to auto-update lot size and fetch last price from T-Bank API
  useEffect(() => {
    const upperTicker = ticker.toUpperCase().trim();
    if (!upperTicker) return;

    const found = tickersList.find(t => t.name === upperTicker);
    if (found) {
      setLotSize(found.lot);
      setMultiplier(found.multiplier || found.lot || 1);
      
      if (window.electronAPI && window.electronAPI.getTickerPrice) {
        window.electronAPI.getTickerPrice(upperTicker).then(price => {
          if (price) {
            setEntryPrice(price.toString());
          }
        });
      }
    }
  }, [ticker, tickersList]);

  // Apply custom accents on change
  useEffect(() => {
    document.documentElement.style.setProperty('--accent-color', accentColor);
    document.documentElement.style.setProperty('--accent-hover', accentHover);
    localStorage.setItem('trade_accent', accentColor);
    localStorage.setItem('trade_accent_hover', accentHover);
  }, [accentColor, accentHover]);

  // Apply opacity setting changes
  useEffect(() => {
    localStorage.setItem('trade_opacity', windowOpacity.toString());
  }, [windowOpacity]);

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

  const handleCloseWindow = () => {
    if (window.electronAPI && window.electronAPI.closeWindow) {
      window.electronAPI.closeWindow();
    }
  };

  // Live calculator helper variables
  const calculatedRiskAmt = entryPrice && stopLoss ? Math.abs(parseFloat(entryPrice) - parseFloat(stopLoss)) : 0;
  const maxRiskPerTradeAmount = (data.deposit * data.settings.maxRiskPerTradePercent) / 100;
  const calculatedMaxLots = calculatedRiskAmt && multiplier 
    ? Math.floor(maxRiskPerTradeAmount / (calculatedRiskAmt * multiplier)) 
    : 0;
  const totalPositionCost = entryPrice && calculatedMaxLots 
    ? calculatedMaxLots * multiplier * parseFloat(entryPrice) 
    : 0;

  // Monthly stats calculations
  const today = new Date();
  const currentMonthTrades = data.trades.filter(t => {
    const tradeDate = new Date(t.entryTime);
    return tradeDate.getMonth() === today.getMonth() && tradeDate.getFullYear() === today.getFullYear();
  });

  const activeTrades = data.trades.filter(t => t.status === 'active');
  const closedTrades = data.trades.filter(t => t.status === 'closed');

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
      return sum + (riskPerShare * t.lots * (t.multiplier || t.lotSize || 1));
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
      alert('Риск-менеджер: Расчетное число лотов равно 0. Сделка отклонена из-за недостаточного капитала или слишком близкого/далекого стоп-лосса.');
      return;
    }

    const plannedTradeRisk = calculatedRiskAmt * calculatedMaxLots * multiplier;
    if (plannedTradeRisk > remainingMonthlyRiskAmount) {
      const proceed = confirm(`Предупреждение риск-менеджера:\nЭта сделка добавит риск в ${formatRub(plannedTradeRisk)}, что превышает оставшийся лимит потерь на месяц (${formatRub(remainingMonthlyRiskAmount)}).\nВы уверены, что хотите открыть сделку?`);
      if (!proceed) return;
    }

    const newTrade = {
      id: tempTradeId,
      ticker: ticker.toUpperCase(),
      lotSize: lotSize,
      multiplier: multiplier,
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
    setIsAddFormOpen(false); // Close modal overlay
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

    const isShort = trade.stopLoss > trade.entryPrice;
    const diff = exitVal - trade.entryPrice;
    const pnlPerShare = isShort ? -diff : diff;
    const totalPnl = pnlPerShare * trade.lots * (trade.multiplier || trade.lotSize || 1);
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

  // Structure closed trades hierarchically: Month -> Week -> Day -> Trades list
  const getGroupedTrades = () => {
    const groups = {};
    const historicalTrades = data.trades.filter(t => t.status === 'closed');
    
    historicalTrades.forEach(t => {
      const date = new Date(t.entryTime);
      const monthKey = `${getMonthNameRU(date)} ${date.getFullYear()}`;
      const weekKey = `Неделя ${getWeekNumber(date)} (${getStartAndEndOfWeek(date)})`;
      const dayKey = `${getDayNameRU(date)}, ${date.getDate()} ${getMonthNameRU(date).toLowerCase().replace(/ь$/, 'я').replace(/т$/, 'та').replace(/й$/, 'я')}`;
      
      if (!groups[monthKey]) groups[monthKey] = {};
      if (!groups[monthKey][weekKey]) groups[monthKey][weekKey] = {};
      if (!groups[monthKey][weekKey][dayKey]) groups[monthKey][weekKey][dayKey] = [];
      
      groups[monthKey][weekKey][dayKey].push(t);
    });

    return groups;
  };

  const groupedTrades = getGroupedTrades();

  // 📈 Analytics engine calculations
  const totalTradesCount = data.trades.length;
  const closedTradesCount = closedTrades.length;
  const profitableTrades = closedTrades.filter(t => t.profitAmount >= 0);
  const unprofitableTrades = closedTrades.filter(t => t.profitAmount < 0);
  const winRate = closedTradesCount > 0 ? (profitableTrades.length / closedTradesCount) * 100 : 0;
  
  const totalProfitAmount = profitableTrades.reduce((sum, t) => sum + t.profitAmount, 0);
  const totalLossAmount = Math.abs(unprofitableTrades.reduce((sum, t) => sum + t.profitAmount, 0));
  const profitFactor = totalLossAmount > 0 ? (totalProfitAmount / totalLossAmount) : totalProfitAmount > 0 ? 99.9 : 0;

  const averageWin = profitableTrades.length > 0 ? totalProfitAmount / profitableTrades.length : 0;
  const averageLoss = unprofitableTrades.length > 0 ? totalLossAmount / unprofitableTrades.length : 0;
  
  const netPnLAmount = closedTrades.reduce((sum, t) => sum + (t.profitAmount || 0), 0);
  const netPnLPercent = data.deposit > 0 ? (netPnLAmount / data.deposit) * 100 : 0;

  // Day of week stats for analytics
  const dayOfWeekStats = [
    { name: 'Пн', count: 0, pnl: 0 },
    { name: 'Вт', count: 0, pnl: 0 },
    { name: 'Ср', count: 0, pnl: 0 },
    { name: 'Чт', count: 0, pnl: 0 },
    { name: 'Пт', count: 0, pnl: 0 }
  ];
  closedTrades.forEach(t => {
    const date = new Date(t.entryTime);
    const dayIndex = date.getDay() - 1; // 0 for Monday, 4 for Friday
    if (dayIndex >= 0 && dayIndex <= 4) {
      dayOfWeekStats[dayIndex].count++;
      dayOfWeekStats[dayIndex].pnl += t.profitAmount || 0;
    }
  });

  // Ticker performance analysis table
  const tickerStatsMap = {};
  closedTrades.forEach(t => {
    if (!tickerStatsMap[t.ticker]) {
      tickerStatsMap[t.ticker] = { count: 0, wins: 0, pnl: 0 };
    }
    tickerStatsMap[t.ticker].count++;
    if (t.profitAmount >= 0) tickerStatsMap[t.ticker].wins++;
    tickerStatsMap[t.ticker].pnl += t.profitAmount || 0;
  });

  const tickerPerformanceList = Object.keys(tickerStatsMap).map(tickerCode => {
    const stat = tickerStatsMap[tickerCode];
    return {
      ticker: tickerCode,
      count: stat.count,
      winrate: stat.count > 0 ? (stat.wins / stat.count) * 100 : 0,
      pnl: stat.pnl
    };
  }).sort((a, b) => b.pnl - a.pnl);

  return (
    <div className="window-container" style={{ '--window-opacity': windowOpacity }}>
      {/* Window Header */}
      <div className="window-header">
        <div className="window-title">
          <span>📈</span>
          <h1>TradingDiary — Журнал сделок</h1>
        </div>

        <div className="window-header-controls">
          {/* Main views toggles */}
          {currentView === 'trades' ? (
            <button 
              className="header-action-btn" 
              onClick={() => setCurrentView('analytics')} 
              title="Перейти к аналитике"
            >
              📊 Аналитика
            </button>
          ) : (
            <button 
              className="header-action-btn" 
              onClick={() => setCurrentView('trades')} 
              title="Вернуться к истории"
            >
              ⬅ К сделкам
            </button>
          )}

          <button 
            className="header-action-btn icon-only" 
            onClick={() => setIsSettingsOpen(!isSettingsOpen)} 
            title="Настройки оформления"
          >
            ⚙️
          </button>
          
          <button className="window-close-btn" onClick={handleCloseWindow} title="Закрыть">✕</button>
        </div>
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
                <button onClick={() => setIsEditingSettings(true)} className="settings-pencil-btn" title="Редактировать параметры риска">⚙️</button>
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

        {/* View content switch */}
        {currentView === 'analytics' ? (
          /* ========================================================== */
          /* ANALYTICS VIEW                                             */
          /* ========================================================== */
          <div className="analytics-view-container">
            <div className="analytics-header-row">
              <h2 className="panel-section-title">📊 Аналитика вашей торговли</h2>
              <button className="analytics-back-btn" onClick={() => setCurrentView('trades')}>
                ⬅ Вернуться в историю сделок
              </button>
            </div>

            <div className="analytics-summary-cards">
              <div className="a-card">
                <div className="a-card-lbl">Чистая прибыль (закрытые)</div>
                <div className={`a-card-val ${netPnLAmount >= 0 ? 'success-text' : 'critical-text'}`}>
                  {netPnLAmount >= 0 ? '+' : ''}{formatRub(netPnLAmount)}
                  <span className="sub-pct"> ({netPnLPercent >= 0 ? '+' : ''}{netPnLPercent.toFixed(2)}%)</span>
                </div>
              </div>

              <div className="a-card">
                <div className="a-card-lbl">Процент прибыльных сделок (Win Rate)</div>
                <div className="a-card-val success-text">
                  {winRate.toFixed(1)}%
                  <span className="sub-pct text-muted"> ({profitableTrades.length} / {closedTradesCount} сд.)</span>
                </div>
                <div className="winrate-bar-track">
                  <div className="winrate-bar-fill" style={{ width: `${winRate}%` }}></div>
                </div>
              </div>

              <div className="a-card">
                <div className="a-card-lbl">Профит-фактор</div>
                <div className="a-card-val font-accent">
                  {profitFactor.toFixed(2)}
                </div>
              </div>

              <div className="a-card">
                <div className="a-card-lbl">Ср. прибыль / Ср. убыток</div>
                <div className="a-card-val-split">
                  <span className="success-text">{formatRub(averageWin)}</span>
                  <span className="text-muted">/</span>
                  <span className="critical-text">{formatRub(averageLoss)}</span>
                </div>
              </div>
            </div>

            <div className="analytics-charts-grid">
              {/* Daily distribution */}
              <div className="analytics-subcard">
                <h3>Распределение P&L по дням недели</h3>
                <div className="chart-bars-container">
                  {dayOfWeekStats.map(d => {
                    const isWin = d.pnl >= 0;
                    // Max absolute height calculation
                    const maxPnl = Math.max(...dayOfWeekStats.map(x => Math.abs(x.pnl))) || 1;
                    const pctHeight = Math.min(100, Math.round((Math.abs(d.pnl) / maxPnl) * 100));
                    
                    return (
                      <div key={d.name} className="chart-bar-column">
                        <div className="chart-bar-label-top" style={{ color: d.pnl === 0 ? 'var(--text-muted)' : isWin ? 'var(--win-color)' : 'var(--loss-color)' }}>
                          {d.pnl === 0 ? '—' : (isWin ? '+' : '-') + Math.round(Math.abs(d.pnl) / 1000) + 'k'}
                        </div>
                        <div className="chart-bar-track">
                          <div 
                            className={`chart-bar-fill ${isWin ? 'win-bar' : 'loss-bar'}`} 
                            style={{ height: `${pctHeight}%` }}
                            title={`${d.name}: ${formatRub(d.pnl)} (${d.count} сд.)`}
                          ></div>
                        </div>
                        <div className="chart-bar-name">{d.name}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Performance by ticker */}
              <div className="analytics-subcard scrollable-card">
                <h3>Эффективность тикеров</h3>
                <table className="ticker-pnl-table">
                  <thead>
                    <tr>
                      <th>Тикер</th>
                      <th>Сделок</th>
                      <th>Win Rate</th>
                      <th>Результат P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickerPerformanceList.length === 0 ? (
                      <tr>
                        <td colSpan="4" className="text-center text-muted">Нет закрытых сделок для анализа</td>
                      </tr>
                    ) : (
                      tickerPerformanceList.map(t => (
                        <tr key={t.ticker}>
                          <td className="bold">{t.ticker}</td>
                          <td>{t.count}</td>
                          <td className="success-text">{t.winrate.toFixed(0)}%</td>
                          <td className={t.pnl >= 0 ? 'success-text bold' : 'critical-text bold'}>
                            {t.pnl >= 0 ? '+' : ''}{formatRub(t.pnl)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : (
          /* ========================================================== */
          /* HISTORY AND ACTIVE TRADES VIEW                             */
          /* ========================================================== */
          <div className="trades-list-full-layout">
            
            {/* Control line containing the primary action button */}
            <div className="trades-list-controls">
              <button 
                className="add-new-trade-trigger-btn"
                onClick={() => setIsAddFormOpen(true)}
              >
                ➕ Добавить сделку
              </button>
            </div>

            {/* Content panel */}
            <div className="trades-scroll-container">
              
              {/* 1. Pinned Active Trades Section */}
              {activeTrades.length > 0 && (
                <div className="active-trades-pinned-section">
                  <div className="pinned-section-title">
                    <span className="pulse-indicator-dot"></span>
                    <h2>Активные сделки в работе</h2>
                  </div>
                  
                  <div className="trades-list-container">
                    {activeTrades.map(t => {
                      const formattedDate = new Date(t.entryTime).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ' ' + new Date(t.entryTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                      
                      return (
                        <div key={t.id} className="trade-item-card active-trade">
                          <div className="trade-card-top-row">
                            <div className="trade-meta-left">
                              <span className="trade-item-ticker">{t.ticker}</span>
                              <span className={`direction-badge ${t.stopLoss > t.entryPrice ? 'direction-short' : 'direction-long'}`}>
                                {t.stopLoss > t.entryPrice ? 'ШОРТ' : 'ЛОНГ'}
                              </span>
                              <span className="trade-item-lots">{t.lots} лот. ({t.lots * (t.lotSize || 1)} шт)</span>
                              <span className="trade-item-time">🕒 Открыта: {formattedDate}</span>
                            </div>
                            
                            <div className="trade-meta-right">
                              <span className="active-trade-label">АКТИВНА</span>
                              <button onClick={() => handleDeleteTrade(t.id)} className="delete-trade-btn" title="Удалить сделку">🗑️</button>
                            </div>
                          </div>

                          <div className="trade-card-details-grid">
                            <div className="trade-prices-col">
                              <div><strong>Вход:</strong> {t.entryPrice} ₽</div>
                              <div><strong>Стоп:</strong> {t.stopLoss} ₽</div>
                              <div><strong>Цель:</strong> {t.takeProfit} ₽</div>
                            </div>

                            <div className="trade-notes-col">
                              {t.noteEntry && (
                                <div className="note-bubble">
                                  <span className="note-lbl">Вход:</span> "{t.noteEntry}"
                                </div>
                              )}
                            </div>

                            <div className="trade-thumbs-col">
                              {t.screenshotEntry ? (
                                <img 
                                  src={t.screenshotEntry} 
                                  alt="Вход" 
                                  className="trade-thumbnail-img" 
                                  onClick={() => setFullscreenImageUrl(t.screenshotEntry)}
                                  title="Кликните для увеличения"
                                />
                              ) : (
                                <div className="empty-thumb-placeholder">Без скрина</div>
                              )}
                              <div className="empty-thumb-placeholder">В процессе</div>
                            </div>
                          </div>

                          <div className="active-trade-actions">
                            <button 
                              onClick={() => handleOpenCloseTradeModal(t)} 
                              className="close-trade-action-btn"
                            >
                              🔒 Закрыть сделку (зафиксировать выход)
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 2. Historical Grouped Trades */}
              <div className="historical-trades-section">
                <div className="pinned-section-title">
                  <h2>Архив закрытых сделок</h2>
                </div>

                {Object.keys(groupedTrades).length === 0 ? (
                  <div className="no-trades-card">
                    <span className="no-trades-icon">📖</span>
                    <p>Нет закрытых сделок. Открывайте и закрывайте сделки, чтобы наполнить историю.</p>
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
                                                const formattedDate = new Date(t.entryTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                                                const endFormattedDate = new Date(t.exitTime).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

                                                return (
                                                  <div 
                                                    key={t.id} 
                                                    className={`trade-item-card ${t.profitAmount >= 0 ? 'win-trade' : 'loss-trade'}`}
                                                  >
                                                    <div className="trade-card-top-row">
                                                      <div className="trade-meta-left">
                                                        <span className="trade-item-ticker">{t.ticker}</span>
                                                        <span className={`direction-badge ${t.stopLoss > t.entryPrice ? 'direction-short' : 'direction-long'}`}>
                                                          {t.stopLoss > t.entryPrice ? 'ШОРТ' : 'ЛОНГ'}
                                                        </span>
                                                        <span className="trade-item-lots">{t.lots} лот. ({t.lots * (t.lotSize || 1)} шт)</span>
                                                        <span className="trade-item-time">🕒 {formattedDate} - {endFormattedDate}</span>
                                                      </div>
                                                      
                                                      <div className="trade-meta-right">
                                                        <span className={`pnl-label ${t.profitAmount >= 0 ? 'pnl-win' : 'pnl-loss'}`}>
                                                          {t.profitAmount >= 0 ? '+' : ''}{formatRub(t.profitAmount)} ({t.profitPercent >= 0 ? '+' : ''}{t.profitPercent.toFixed(2)}%)
                                                        </span>
                                                        <button onClick={() => handleDeleteTrade(t.id)} className="delete-trade-btn" title="Удалить сделку">🗑️</button>
                                                      </div>
                                                    </div>

                                                    <div className="trade-card-details-grid">
                                                      <div className="trade-prices-col">
                                                        <div><strong>Вход:</strong> {t.entryPrice} ₽</div>
                                                        <div><strong>Стоп:</strong> {t.stopLoss} ₽</div>
                                                        <div><strong>Цель:</strong> {t.takeProfit} ₽</div>
                                                        <div><strong>Выход:</strong> {t.exitPrice} ₽</div>
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
                                                        {t.screenshotEntry ? (
                                                          <img 
                                                            src={t.screenshotEntry} 
                                                            alt="Вход" 
                                                            className="trade-thumbnail-img" 
                                                            onClick={() => setFullscreenImageUrl(t.screenshotEntry)}
                                                            title="Кликните для увеличения"
                                                          />
                                                        ) : (
                                                          <div className="empty-thumb-placeholder">Вход</div>
                                                        )}
                                                        {t.screenshotExit ? (
                                                          <img 
                                                            src={t.screenshotExit} 
                                                            alt="Выход" 
                                                            className="trade-thumbnail-img" 
                                                            onClick={() => setFullscreenImageUrl(t.screenshotExit)}
                                                            title="Кликните для увеличения"
                                                          />
                                                        ) : (
                                                          <div className="empty-thumb-placeholder">Выход</div>
                                                        )}
                                                      </div>
                                                    </div>
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

            {/* Custom Overlay covering the bottom trades area only (keeping dashboard visible) */}
            {isAddFormOpen && (
              <div className="add-trade-overlay">
                <div className="add-trade-overlay-content">
                  <div className="overlay-header-row">
                    <h3>➕ Открытие новой сделки</h3>
                    <button className="overlay-close-btn" onClick={() => setIsAddFormOpen(false)}>✕</button>
                  </div>

                  <form onSubmit={handleAddTrade} className="add-trade-form">
                    <div className="form-row">
                      <div className="form-group flex-2">
                        <label>Ассет (тикер на MOEX)</label>
                        <TickerAutocomplete 
                          value={ticker} 
                          onChange={setTicker} 
                          onSelectLot={setLotSize}
                          tickersList={tickersList}
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
                          <span>Направление сделки:</span>
                          <span className={`calc-summary-val ${parseFloat(stopLoss) > parseFloat(entryPrice) ? 'danger-text' : 'success-text'}`}>
                            {parseFloat(stopLoss) > parseFloat(entryPrice) ? '🔴 ШОРТ (Продажа)' : '🟢 ЛОНГ (Покупка)'}
                          </span>
                        </div>
                        <div className="calc-summary-row">
                          <span>Объем входа:</span>
                          <span className="calc-summary-val highlighted-lots">{calculatedMaxLots} лотов <span className="sub">({calculatedMaxLots * lotSize} ед. актива)</span></span>
                        </div>
                        <div className="calc-summary-row">
                          <span>Стоимость позиции:</span>
                          <span className="calc-summary-val">{formatRub(totalPositionCost)}</span>
                        </div>
                        <div className="calc-summary-row">
                          <span>Риск сделки:</span>
                          <span className="calc-summary-val danger-text">
                            {formatRub(calculatedRiskAmt * calculatedMaxLots * multiplier)} 
                            &nbsp;({((calculatedRiskAmt * calculatedMaxLots * multiplier) / data.deposit * 100).toFixed(2)}%)
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <div className="form-group">
                      <label>Мысли / Стратегия входа</label>
                      <textarea 
                        value={noteEntry} 
                        onChange={(e) => setNoteEntry(e.target.value)} 
                        placeholder="Какое эмоциональное состояние? Почему открываю эту сделку?" 
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

                    <div className="overlay-footer-buttons">
                      <button type="button" className="cancel-trade-btn" onClick={() => setIsAddFormOpen(false)}>Отмена</button>
                      <button type="submit" className="submit-trade-btn">🚀 Открыть активную сделку</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal: Transparency & Theme Customization */}
      {isSettingsOpen && (
        <div className="settings-overlay-floating">
          <div className="settings-content-floating">
            <div className="settings-header-floating">
              <h3>🎨 Настройки оформления</h3>
              <button className="settings-close-floating" onClick={() => setIsSettingsOpen(false)}>✕</button>
            </div>
            
            <div className="settings-body-floating">
              <div className="settings-row-floating">
                <label>Прозрачность окна: {(windowOpacity * 100).toFixed(0)}%</label>
                <input 
                  type="range" 
                  min="0.3" 
                  max="1.0" 
                  step="0.05"
                  value={windowOpacity} 
                  onChange={(e) => setWindowOpacity(parseFloat(e.target.value))}
                  className="opacity-slider"
                />
              </div>

              <div className="settings-row-floating">
                <label>Цветовой оттенок:</label>
                <div className="accents-palette-row">
                  {colorOptions.map(color => (
                    <div 
                      key={color.name}
                      className={`color-circle-option ${accentColor === color.primary ? 'active' : ''}`}
                      style={{ backgroundColor: color.primary }}
                      title={color.name}
                      onClick={() => {
                        setAccentColor(color.primary);
                        setAccentHover(color.hover);
                      }}
                    />
                  ))}
                </div>
              </div>

              <div className="settings-row-floating">
                <label>T-Bank API Токен:</label>
                <div style={{ display: 'flex', gap: '6px', width: '100%', marginBottom: '8px' }}>
                  <input 
                    type="password" 
                    value={tbankToken} 
                    onChange={(e) => setTbankToken(e.target.value)} 
                    placeholder="Токен API..." 
                    className="trade-input" 
                    style={{ flex: 1, padding: '6px 8px', fontSize: '11px', minHeight: 'auto' }}
                  />
                  <button 
                    type="button" 
                    onClick={handleSaveTbankToken} 
                    className="submit-trade-btn" 
                    style={{ flexShrink: 0, padding: '6px 10px', fontSize: '11px', width: 'auto', margin: 0 }}
                  >
                    {isTokenSaved ? '✓' : 'Сохранить'}
                  </button>
                </div>
                {tbankToken && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                    <button
                      type="button"
                      onClick={handleSyncTickers}
                      disabled={isSyncing}
                      className="submit-trade-btn"
                      style={{ padding: '6px 10px', fontSize: '11px', width: 'auto', margin: 0, background: 'var(--accent-hover)', color: '#000' }}
                    >
                      {isSyncing ? 'Синхронизация...' : '🔄 Синхронизировать тикеры'}
                    </button>
                    {syncStatus && (
                      <span style={{ fontSize: '10px', color: syncStatus.startsWith('Ошибка') ? '#ff7575' : '#3ddc84', wordBreak: 'break-all' }}>
                        {syncStatus}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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

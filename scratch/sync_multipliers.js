const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
const TRADING_DIR = "D:\\GoogleDisk\\Docs\\TradingDiary";
const TRADING_DATA_DIR = path.join(TRADING_DIR, "data");
const TRADING_TICKERS_PATH = path.join(TRADING_DATA_DIR, "tickers.json");

async function run() {
  try {
    if (!fs.existsSync(configPath)) {
      console.error('Config file not found');
      return;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const token = config.tbankToken;
    if (!token) {
      console.error('Token not found');
      return;
    }

    console.log('Syncing multipliers...');
    const [sharesRes, futuresRes] = await Promise.all([
      fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/Shares', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' })
      }),
      fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/Futures', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' })
      })
    ]);

    if (!sharesRes.ok || !futuresRes.ok) {
      console.error('Failed to fetch', sharesRes.status, futuresRes.status);
      return;
    }

    const sharesData = await sharesRes.json();
    const futuresData = await futuresRes.json();

    const sharesList = (sharesData.instruments || [])
      .filter(ins => ins.ticker && ins.figi && (ins.classCode === 'TQBR' || ins.classCode === 'TQTF'))
      .map(ins => {
        const lotVal = parseInt(ins.lot) || 1;
        return {
          name: ins.ticker,
          lot: lotVal,
          fullname: ins.name || '',
          figi: ins.figi,
          multiplier: lotVal
        };
      });

    const futuresList = (futuresData.instruments || [])
      .filter(ins => ins.ticker && ins.figi && ins.classCode === 'SPBFUT')
      .map(ins => {
        let assetSize = 1;
        if (ins.basicAssetSize) {
          const units = parseInt(ins.basicAssetSize.units) || 0;
          const nano = parseInt(ins.basicAssetSize.nano) || 0;
          assetSize = units + (nano / 1e9);
        }
        
        let priceMult = assetSize || parseInt(ins.lot) || 1;
        if (ins.minPriceIncrement && ins.minPriceIncrementAmount) {
          const inc = (parseInt(ins.minPriceIncrement.units) || 0) + ((parseInt(ins.minPriceIncrement.nano) || 0) / 1e9);
          const amt = (parseInt(ins.minPriceIncrementAmount.units) || 0) + ((parseInt(ins.minPriceIncrementAmount.nano) || 0) / 1e9);
          if (inc > 0) {
            priceMult = amt / inc;
          }
        }
        
        return {
          name: ins.ticker,
          lot: assetSize || parseInt(ins.lot) || 1,
          fullname: ins.name || '',
          figi: ins.figi,
          multiplier: priceMult
        };
      });

    const tickers = [...sharesList, ...futuresList];
    fs.writeFileSync(TRADING_TICKERS_PATH, JSON.stringify(tickers, null, 2), 'utf-8');
    console.log(`Successfully synced ${tickers.length} tickers with multipliers!`);
  } catch (e) {
    console.error('Error:', e);
  }
}

run();

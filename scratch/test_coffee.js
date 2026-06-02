async function run() {
  const token = 't.X-p76-wuxpoekS9r3IQcDhduQMqc8ac5MPTHMAoLyCvitGffXqXtU2bxth8_Lpw8X7kn-gbciimAON1TjFMCKg';
  const response = await fetch('https://invest-public-api.tinkoff.ru/rest/tinkoff.public.invest.api.contract.v1.InstrumentsService/Futures', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ instrumentStatus: 'INSTRUMENT_STATUS_BASE' })
  });
  
  if (!response.ok) {
    console.error('Failed', response.status);
    return;
  }
  
  const data = await response.json();
  const coffeeFutures = (data.instruments || []).filter(ins => ins.ticker && ins.ticker.includes('KCM6'));
  console.log(JSON.stringify(coffeeFutures, null, 2));
}

run();

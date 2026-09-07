const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Тестовый сервер работает!' });
});

app.get('/api/test', (req, res) => {
  res.json({ test: 'ok', message: 'API работает!' });
});

app.get('/api/getStats', (req, res) => {
  res.json({ stats: 'work', users: 10, balance: 100 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Тестовый сервер запущен на порту ${PORT}`);
});

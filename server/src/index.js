import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { validateMessage } from './routes/validate.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ online: true });
});

app.post('/api/validate', validateMessage);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

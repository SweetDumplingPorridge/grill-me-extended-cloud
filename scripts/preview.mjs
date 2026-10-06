import express from 'express';
import path from 'node:path';
const app = express();
app.use(express.static(path.resolve('web')));
app.get('/', (_req, res) => res.sendFile(path.resolve('web/test/index.html')));
app.listen(4173, '127.0.0.1', () => console.error('Questionnaire preview: http://127.0.0.1:4173'));

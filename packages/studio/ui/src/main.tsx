import { createRoot } from 'react-dom/client';

import './index.css';
import { createApi } from '@/api';
import { App } from '@/app';

createRoot(document.getElementById('root')!).render(<App api={createApi()} />);

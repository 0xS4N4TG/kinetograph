import { createRoot } from 'react-dom/client';

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
import './index.css';
import { App } from '@/App';

createRoot(document.getElementById('root')!).render(<App />);

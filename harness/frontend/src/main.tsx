/**
 * FAQAT HARNESS. Modul sahifalarini lokal "qobiq" ichida ko'rsatadi:
 * soxta auth header'lari + `/api` proxy.
 *
 * Asosiy repoda bu fayl o'rniga o'z `App.tsx`/router'ingiz bo'ladi va
 * `request` funksiyasi sizning `api.ts` dan keladi.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TrainingApp } from '../../../module/frontend/src/TrainingApp.js';
import { createTrainingApi, type ApiRequestInit } from '../../../module/frontend/src/lib/api.js';
import '../../../module/frontend/src/styles.css';

/** Soxta auth: header'lar bilan dev foydalanuvchi (faqat lokal). */
const DEV_HEADERS: Record<string, string> = {
  'x-business-id': '11111111-1111-1111-1111-111111111111',
  'x-user-id': '22222222-2222-2222-2222-222222222222',
};

async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...DEV_HEADERS,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await response.json());
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(`${response.status} ${detail.slice(0, 300)}`);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

const api = createTrainingApi(request);

interface HarnessInfo {
  profileKey: string;
  industry: string;
  callDirection: 'inbound' | 'outbound' | 'mixed';
  llm: string;
}

function Shell(): JSX.Element {
  const [info, setInfo] = useState<HarnessInfo | null>(null);

  useEffect(() => {
    void request<HarnessInfo>('/api/v1/training/_harness')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <>
      <div
        style={{
          font: '13px system-ui, sans-serif',
          background: '#fff7e6',
          color: '#7a5200',
          borderBottom: '1px solid #f0d79a',
          padding: '6px 12px',
        }}
      >
        <b>Lokal harness</b>
        {info ? (
          <>
            {' '}
            · profil: {info.profileKey} ({info.industry}) · LLM: {info.llm}
            {info.llm === 'demo' ? ' (kalit yo’q — javoblar sodda)' : ''}
          </>
        ) : (
          ' · backend ulanmadi: `npm run serve` ishlayaptimi?'
        )}
      </div>
      <TrainingApp
        api={api}
        callDirection={info?.callDirection ?? 'mixed'}
        canViewAll
        debug
      />
    </>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root topilmadi');
createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);

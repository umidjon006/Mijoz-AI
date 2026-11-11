/**
 * "Ssenariy yaratish" — FAQAT rahbar (sotuv bo'limi boshlig'i) uchun.
 *
 * Bo'limlar: Mijoz, Vaziyat, Emotsiya, Til, Ovoz. "AI bilan to'ldirish" —
 * erkin matndan taklif (saqlanmaydi, formaga tushadi). "Sinab ko'rish" —
 * saqlamasdan 2-3 navbat. "Saqlash" — server to'liq tekshiradi.
 * Hamma tekshiruv serverda (bitta sxema); forma faqat ko'rsatadi.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { errorText } from '../lib/api-error.js';
import type {
  ManagedScenario,
  ScenarioDraft,
  ScenarioIssue,
  SellerProfile,
  TrainingApi,
  TranscriptTurn,
  TryTurnResponse,
} from '../lib/api.js';
import { usePresentation } from '../lib/presentation.js';
import { DifficultyDots, Notice } from '../components/ui.js';

// Server `content-rules.ts` dagi ro'yxat bilan bir xil (frontend backend'ni import qilmaydi).
const TRAITS: Array<[string, string]> = [
  ['jahldor', 'Jahldor'],
  ['shoshqaloq', 'Shoshqaloq'],
  ['ishonchsiz', 'Ishonchsiz'],
  ['kinoyali', 'Kinoyali'],
  ['injiq', 'Injiq'],
  ['charchagan', 'Charchagan'],
  ['ikkilanuvchi', 'Ikkilanuvchi'],
  ['gapni_boluvchi', "Gapni bo'luvchi"],
  ['kam_gapiradigan', 'Kam gapiradigan'],
  ['iliq', 'Iliq'],
];
const MAX_TRAITS = 4;
const RELATIONS: Array<[string, string]> = [
  ['father', 'Otasi'],
  ['mother', 'Onasi'],
  ['grandmother', 'Buvisi'],
  ['grandfather', 'Bobosi'],
  ['brother', 'Akasi'],
  ['sister', 'Opasi'],
  ['self', "O'zi o'qimoqchi"],
  ['other', 'Boshqa'],
];
const ROLES: Array<[string, string]> = [
  ['parent', 'Ota-ona'],
  ['self_learner', "O'zi o'qimoqchi (katta yoshli)"],
  ['grandparent', 'Buvi / bobo'],
  ['teenager', "O'smir"],
  ['child', 'Bola'],
  ['businessman', 'Tadbirkor'],
];
const RELATION_ROLE: Record<string, string> = {
  father: 'parent',
  mother: 'parent',
  grandmother: 'grandparent',
  grandfather: 'grandparent',
  self: 'self_learner',
};

type Obj = Record<string, unknown>;

function emptyScenario(): ScenarioDraft {
  return {
    title_uz: '',
    description_uz: '',
    difficulty: 3,
    call_direction: 'outbound',
    relationship: 'new_lead',
    persona: {
      gender: '',
      age: { min: 35, max: 45 },
      role: 'parent',
      name_pool: [],
      backstory: '',
      relation: 'father',
      situation: { money: 'medium', busy: 'medium', studied_before: false },
    },
    hidden_reason: '',
    real_objection: '',
    success_condition: '',
    hangup_condition: "Sotuvchi qo'pollik qilsa yoki bosimni to'xtatmasa.",
    emotion: {
      baseline: { anger: 30, trust: 40, interest: 50, patience: 70 },
      volatility: 'medium',
      may_hang_up: true,
      traits: [],
      triggers: { anger_up: [], anger_down: [], trust_up: [], trust_down: [], interest_up: [], interest_down: [] },
    },
    behavior: {
      default_formality: 'siz',
      allow_sen_when_angry: false,
      sarcasm: 0,
      insult_level: 0,
      randomization_notes: [],
    },
    voice: { profile: 'auto', base_style: 'A natural Uzbek customer on the phone.' },
  };
}

/** Ichki maydonni o'qish/yozish ("persona.age.min"). */
function getAt(o: Obj, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Obj)[k] : undefined), o);
}
function setAt(o: Obj, path: string, value: unknown): Obj {
  const keys = path.split('.');
  const copy: Obj = structuredClone(o);
  let cur: Obj = copy;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Obj;
  }
  cur[keys[keys.length - 1] as string] = value;
  return copy;
}

/** Bola/o'smir: haqorat 0, kinoya <= 1, "sen" yo'q — forma ham shunday cheklaydi. */
function applyMinorCaps(s: Obj): Obj {
  const role = getAt(s, 'persona.role');
  if (role !== 'child' && role !== 'teenager') return s;
  let out = setAt(s, 'behavior.insult_level', 0);
  out = setAt(out, 'behavior.allow_sen_when_angry', false);
  const sarcasm = Number(getAt(out, 'behavior.sarcasm') ?? 0);
  return sarcasm > 1 ? setAt(out, 'behavior.sarcasm', 1) : out;
}

export interface ScenarioBuilderPageProps {
  api: TrainingApi;
}

export function ScenarioBuilderPage({ api }: ScenarioBuilderPageProps): JSX.Element {
  const presentation = usePresentation();
  const [list, setList] = useState<ManagedScenario[] | null>(null);
  const [draft, setDraft] = useState<ScenarioDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [issues, setIssues] = useState<ScenarioIssue[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiText, setAiText] = useState('');
  const [voices, setVoices] = useState<Array<{ key: string; voice: string }>>([]);

  async function refresh(): Promise<void> {
    try {
      setList(await api.listManagedScenarios());
    } catch (err) {
      setError(errorText(err, presentation));
    }
  }

  useEffect(() => {
    void refresh();
    void api.voiceProfiles().then(setVoices);
  }, [api]);

  // Jonli tekshiruv (server) — yozish to'xtagach 600 ms.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draft) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api
        .validateScenario({ ...draft, id: editingId ?? 'qoralama' })
        .then((r) => {
          setIssues(r.issues);
          setWarnings(r.warnings);
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft, editingId, api]);

  const issueFor = (prefix: string): string | null => {
    const hit = issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
    return hit.length ? hit.map((i) => i.message).join('; ') : null;
  };

  function update(path: string, value: unknown): void {
    setDraft((d) => (d ? applyMinorCaps(setAt(d, path, value)) : d));
    setInfo(null);
  }

  async function openEdit(id: string): Promise<void> {
    setError(null);
    try {
      const rec = await api.getScenario(id);
      setDraft(rec.scenario);
      setEditingId(id);
    } catch (err) {
      setError(errorText(err, presentation));
    }
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      const res = editingId ? await api.updateScenario(editingId, draft) : await api.createScenario(draft);
      setInfo(`Saqlandi: "${String(res.scenario.title_uz)}". Endi sotuvchilarning "Mashq" sahifasida ko'rinadi.`);
      setWarnings(res.warnings);
      setEditingId(String(res.scenario.id));
      setDraft(res.scenario);
      await refresh();
    } catch (err) {
      const body = (err as { body?: { issues?: ScenarioIssue[]; message?: string } }).body;
      if (body?.issues?.length) setIssues(body.issues);
      setError(body?.issues?.length ? "Saqlanmadi — quyidagi xatolarni tuzating." : errorText(err, presentation));
    } finally {
      setBusy(null);
    }
  }

  async function aiFill(): Promise<void> {
    setBusy('ai');
    setError(null);
    try {
      const r = await api.aiDraftScenario(aiText);
      if (r.scenario) setDraft(applyMinorCaps({ ...emptyScenario(), ...r.scenario }));
      setIssues(r.issues);
      setWarnings(r.warnings);
      setInfo(
        r.ok
          ? "AI taklifi formaga qo'yildi. Tekshirib, kerak bo'lsa tahrirlang — avtomatik SAQLANMAYDI."
          : "AI taklifida xatolar bor — belgilangan maydonlarni tuzating.",
      );
    } catch (err) {
      setError(errorText(err, presentation));
    } finally {
      setBusy(null);
    }
  }

  if (!draft) {
    return (
      <div>
        <h1 className="mq-h1">Ssenariy yaratish</h1>
        <p className="mq-sub">Sotuvchilar mashq qiladigan mijozlarni shu yerda yaratasiz va boshqarasiz.</p>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <div className="mq-btn-row" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className="mq-btn mq-btn-primary"
            onClick={() => {
              setDraft(emptyScenario());
              setEditingId(null);
              setIssues([]);
              setWarnings([]);
            }}
          >
            + Yangi ssenariy
          </button>
        </div>
        {list === null ? (
          <p className="mq-muted">Yuklanmoqda…</p>
        ) : list.length === 0 ? (
          <p className="mq-muted">Hali ssenariy yo'q.</p>
        ) : (
          <table className="mq-table">
            <thead>
              <tr>
                <th>Nomi</th>
                <th>Qiyinlik</th>
                <th>Holat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} style={s.isActive ? undefined : { opacity: 0.55 }}>
                  <td>
                    {s.title}
                    {s.content.harsh ? <span className="mq-muted mq-small"> · ⚠ qo'pol til</span> : null}
                  </td>
                  <td>
                    <DifficultyDots level={s.difficulty} />
                  </td>
                  <td className="mq-small">{s.isActive ? 'faol' : 'arxivda'}</td>
                  <td className="mq-btn-row">
                    <button type="button" className="mq-btn mq-small" onClick={() => void openEdit(s.id)}>
                      Tahrirlash
                    </button>
                    <button
                      type="button"
                      className="mq-btn mq-small"
                      onClick={() => void api.duplicateScenario(s.id).then(refresh).catch((e) => setError(errorText(e, presentation)))}
                    >
                      Nusxa
                    </button>
                    <button
                      type="button"
                      className="mq-btn mq-small"
                      onClick={() =>
                        void api.archiveScenario(s.id, s.isActive).then(refresh).catch((e) => setError(errorText(e, presentation)))
                      }
                    >
                      {s.isActive ? 'Arxivlash' : 'Qaytarish'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  const s = draft as Obj;
  const role = String(getAt(s, 'persona.role') ?? 'parent');
  const minor = role === 'child' || role === 'teenager';
  const traits = (getAt(s, 'emotion.traits') as string[] | undefined) ?? [];
  const names = ((getAt(s, 'persona.name_pool') as string[] | undefined) ?? []).join(', ');

  const text = (path: string, label: string, opts: { area?: boolean; placeholder?: string } = {}) => (
    <label className="mq-field">
      <span className="mq-small">{label}</span>
      {opts.area ? (
        <textarea
          rows={3}
          value={String(getAt(s, path) ?? '')}
          placeholder={opts.placeholder}
          onChange={(e) => update(path, e.target.value)}
        />
      ) : (
        <input value={String(getAt(s, path) ?? '')} placeholder={opts.placeholder} onChange={(e) => update(path, e.target.value)} />
      )}
      {issueFor(path) ? <span className="mq-field-error">{issueFor(path)}</span> : null}
    </label>
  );
  const select = (path: string, label: string, options: Array<[string, string]>, onPick?: (v: string) => void) => (
    <label className="mq-field">
      <span className="mq-small">{label}</span>
      <select
        value={String(getAt(s, path) ?? '')}
        onChange={(e) => (onPick ? onPick(e.target.value) : update(path, e.target.value))}
      >
        <option value="" disabled>
          — tanlang —
        </option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {issueFor(path) ? <span className="mq-field-error">{issueFor(path)}</span> : null}
    </label>
  );
  const slider = (path: string, label: string) => (
    <label className="mq-field">
      <span className="mq-small">
        {label}: <b>{Number(getAt(s, path) ?? 0)}</b>
      </span>
      <input type="range" min={0} max={100} step={5} value={Number(getAt(s, path) ?? 0)} onChange={(e) => update(path, Number(e.target.value))} />
    </label>
  );
  const level = (path: string, label: string, max: number, disabledAbove?: number) => (
    <label className="mq-field">
      <span className="mq-small">{label}</span>
      <select value={Number(getAt(s, path) ?? 0)} onChange={(e) => update(path, Number(e.target.value))}>
        {Array.from({ length: max + 1 }, (_, i) => (
          <option key={i} value={i} disabled={disabledAbove !== undefined && i > disabledAbove}>
            {i}
          </option>
        ))}
      </select>
      {issueFor(path) ? <span className="mq-field-error">{issueFor(path)}</span> : null}
    </label>
  );

  return (
    <div>
      <h1 className="mq-h1">{editingId ? 'Ssenariyni tahrirlash' : 'Yangi ssenariy'}</h1>
      <div className="mq-btn-row" style={{ marginBottom: 12 }}>
        <button type="button" className="mq-btn mq-small" onClick={() => setDraft(null)}>
          ← Ro'yxatga
        </button>
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {info ? <Notice kind="info">{info}</Notice> : null}

      {/* --- AI bilan to'ldirish ------------------------------------------- */}
      <section className="mq-panel" style={{ marginBottom: 16 }}>
        <h2 className="mq-h2">AI bilan to'ldirish</h2>
        <p className="mq-small mq-muted">
          Vaziyatni o'z so'zlaringiz bilan yozing — AI qolgan hamma maydonni taklif qiladi. Taklif saqlanmaydi: tekshirib, tahrirlab, keyin saqlaysiz.
        </p>
        <textarea
          rows={3}
          style={{ width: '100%' }}
          value={aiText}
          placeholder="Masalan: 45 yoshli ota, o'g'li 2 oy o'qidi va tashlab ketdi, endi pulini qaytarishni talab qilyapti, jahli chiqqan…"
          onChange={(e) => setAiText(e.target.value)}
        />
        <button type="button" className="mq-btn" disabled={aiText.trim().length < 10 || busy !== null} onClick={() => void aiFill()}>
          {busy === 'ai' ? 'AI o\'ylayapti…' : 'AI bilan to\'ldirish'}
        </button>
      </section>

      <section className="mq-panel">
        {text('title_uz', 'Nomi')}

        <h2 className="mq-h2">Mijoz</h2>
        <div className="mq-grid">
          <label className="mq-field">
            <span className="mq-small">Ism (bitta — aniq ism; vergul bilan bir nechta — tasodifiy)</span>
            <input
              defaultValue={names}
              key={editingId ?? 'new'}
              placeholder="Rustam, Akmal, Farhod"
              onBlur={(e) =>
                update(
                  'persona.name_pool',
                  e.target.value
                    .split(',')
                    .map((n) => n.trim())
                    .filter(Boolean),
                )
              }
            />
            {issueFor('persona.name_pool') ? <span className="mq-field-error">{issueFor('persona.name_pool')}</span> : null}
          </label>
          {select('persona.gender', 'Jinsi', [
            ['male', 'Erkak'],
            ['female', 'Ayol'],
          ])}
          <label className="mq-field">
            <span className="mq-small">Yoshi (dan–gacha)</span>
            <span>
              <input type="number" style={{ width: 70 }} value={Number(getAt(s, 'persona.age.min') ?? 0)} onChange={(e) => update('persona.age.min', Number(e.target.value))} />
              {' – '}
              <input type="number" style={{ width: 70 }} value={Number(getAt(s, 'persona.age.max') ?? 0)} onChange={(e) => update('persona.age.max', Number(e.target.value))} />
            </span>
            {issueFor('persona.age') ? <span className="mq-field-error">{issueFor('persona.age')}</span> : null}
          </label>
          {select('persona.relation', "O'quvchiga kim", RELATIONS, (v) => {
            update('persona.relation', v);
            const r = RELATION_ROLE[v];
            if (r) setDraft((d) => (d ? applyMinorCaps(setAt(setAt(d, 'persona.relation', v), 'persona.role', r)) : d));
          })}
          {select('persona.role', 'Roli', ROLES)}
          {select('persona.situation.money', 'Pul', [
            ['good', 'Yaxshi'],
            ['medium', "O'rta"],
            ['hard', 'Qiyin'],
          ])}
          {select('persona.situation.busy', 'Bandligi', [
            ['free', "Bo'sh"],
            ['medium', "O'rta"],
            ['very_busy', 'Juda band'],
          ])}
          <label className="mq-field">
            <span className="mq-small">Avval shu yerda o'qiganmi?</span>
            <input
              type="checkbox"
              checked={getAt(s, 'persona.situation.studied_before') === true}
              onChange={(e) => update('persona.situation.studied_before', e.target.checked)}
            />
          </label>
        </div>

        <h2 className="mq-h2">Vaziyat</h2>
        {text('description_uz', 'Vaziyat (qisqa tavsif — sotuvchiga ko\'rinadi)', { area: true })}
        {text('persona.backstory', 'Mijoz tarixi (AI mijozga beriladi)', { area: true })}
        <div className="mq-grid">
          {select('call_direction', "Qo'ng'iroq", [
            ['outbound', 'Biz qo\'ng\'iroq qilamiz'],
            ['inbound', "Mijoz qo'ng'iroq qiladi"],
          ])}
          {select('relationship', 'Munosabat', [
            ['new_lead', 'Yangi mijoz'],
            ['existing_student_parent', "O'qiyotgan o'quvchining yaqini"],
            ['debtor', 'Qarzdor'],
            ['other', 'Boshqa'],
          ])}
          {level('difficulty', 'Qiyinlik (1–5)', 5)}
        </div>
        {text('hidden_reason', 'Yashirin sabab (sotuvchi topishi kerak)', { area: true })}
        {text('real_objection', "Asosiy e'tiroz", { area: true })}
        {text('success_condition', 'Muvaffaqiyat sharti (qachon rozi bo\'ladi)', { area: true })}
        {text('hangup_condition', "Go'shak qo'yish sharti", { area: true })}

        <h2 className="mq-h2">Emotsiya</h2>
        <div className="mq-grid">
          {slider('emotion.baseline.anger', 'Jahl')}
          {slider('emotion.baseline.trust', 'Ishonch')}
          {slider('emotion.baseline.interest', 'Qiziqish')}
          {slider('emotion.baseline.patience', 'Sabr')}
        </div>
        <div className="mq-field">
          <span className="mq-small">Xususiyatlar (ko'pi bilan {MAX_TRAITS} ta)</span>
          <div className="mq-btn-row">
            {TRAITS.map(([key, label]) => {
              const on = traits.includes(key);
              return (
                <button
                  type="button"
                  key={key}
                  className={`mq-chip${on ? ' mq-chip-on' : ''}`}
                  aria-pressed={on}
                  disabled={!on && traits.length >= MAX_TRAITS}
                  onClick={() => update('emotion.traits', on ? traits.filter((t) => t !== key) : [...traits, key])}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {issueFor('emotion.traits') ? <span className="mq-field-error">{issueFor('emotion.traits')}</span> : null}
        </div>
        <div className="mq-grid">
          {select('emotion.volatility', "O'zgaruvchanlik", [
            ['slow', 'Sekin'],
            ['medium', "O'rta"],
            ['fast', 'Tez'],
          ])}
          <label className="mq-field">
            <span className="mq-small">Go'shak qo'ya oladimi?</span>
            <input type="checkbox" checked={getAt(s, 'emotion.may_hang_up') === true} onChange={(e) => update('emotion.may_hang_up', e.target.checked)} />
          </label>
        </div>

        <h2 className="mq-h2">Til</h2>
        {minor ? <p className="mq-small mq-muted">Bola/o'smir: haqorat 0, kinoya ko'pi bilan 1, "sen" yo'q (avtomatik).</p> : null}
        <div className="mq-grid">
          <label className="mq-field">
            <span className="mq-small">Jahli chiqsa "siz"dan "sen"ga o'tishi mumkin</span>
            <input
              type="checkbox"
              disabled={minor}
              checked={getAt(s, 'behavior.allow_sen_when_angry') === true}
              onChange={(e) => update('behavior.allow_sen_when_angry', e.target.checked)}
            />
          </label>
          {level('behavior.sarcasm', 'Kinoya (0–2)', 2, minor ? 1 : undefined)}
          {level('behavior.insult_level', "Haqorat (0–2; so'kinish har doim taqiq)", 2, minor ? 0 : undefined)}
        </div>

        <h2 className="mq-h2">Ovoz</h2>
        <VoicePicker api={api} draft={s} voices={voices} onPick={(v) => update('voice.profile', v)} />
        {text('voice.base_style', 'Ovoz uslubi (ixtiyoriy tavsif)')}
      </section>

      {warnings.length ? (
        <Notice kind="warn">
          {warnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </Notice>
      ) : null}
      {issues.length ? (
        <Notice kind="error">
          <b>Saqlashdan oldin tuzating:</b>
          {issues.map((i) => (
            <div key={`${i.path}-${i.message}`}>
              {i.field}: {i.message}
            </div>
          ))}
        </Notice>
      ) : null}

      <TryPanel api={api} draft={s} />

      <div className="mq-btn-row" style={{ marginTop: 16 }}>
        <button type="button" className="mq-btn mq-btn-primary" disabled={busy !== null || issues.length > 0} onClick={() => void save()}>
          {busy === 'save' ? 'Saqlanmoqda…' : 'Saqlash'}
        </button>
      </div>
    </div>
  );
}

/** Ovoz: avtomatik (jins/yosh) yoki qo'lda; namuna tinglash. */
function VoicePicker({
  api,
  draft,
  voices,
  onPick,
}: {
  api: TrainingApi;
  draft: Obj;
  voices: Array<{ key: string; voice: string }>;
  onPick: (v: string) => void;
}): JSX.Element {
  const [playing, setPlaying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const gender = getAt(draft, 'persona.gender');
  const ageMin = Number(getAt(draft, 'persona.age.min') ?? 40);
  const ageMax = Number(getAt(draft, 'persona.age.max') ?? 40);

  async function play(): Promise<void> {
    if (gender !== 'male' && gender !== 'female') {
      setErr('Avval mijoz jinsini tanlang.');
      return;
    }
    setPlaying(true);
    setErr(null);
    try {
      const r = await api.voiceSample({
        profile: String(getAt(draft, 'voice.profile') ?? 'auto'),
        gender,
        age: Math.round((ageMin + ageMax) / 2),
        baseStyle: String(getAt(draft, 'voice.base_style') ?? ''),
      });
      await new Audio(`data:${r.mime};base64,${r.audioBase64}`).play();
    } catch {
      setErr("Namuna olinmadi (ovoz o'chiq yoki limit).");
    } finally {
      setPlaying(false);
    }
  }

  return (
    <div className="mq-btn-row">
      <label className="mq-field">
        <span className="mq-small">Ovoz</span>
        <select value={String(getAt(draft, 'voice.profile') ?? 'auto')} onChange={(e) => onPick(e.target.value)}>
          <option value="auto">Avtomatik (jins va yoshga qarab)</option>
          {voices.map((v) => (
            <option key={v.key} value={v.key}>
              {v.key} ({v.voice})
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="mq-btn mq-small" disabled={playing || voices.length === 0} onClick={() => void play()}>
        {playing ? '…' : '▶ Tinglash'}
      </button>
      {voices.length === 0 ? <span className="mq-small mq-muted">Namuna faqat Gemini TTS yoqilganda.</span> : null}
      {err ? <span className="mq-field-error">{err}</span> : null}
    </div>
  );
}

const TRY_LIMIT = 3;

/** "Sinab ko'rish": saqlamasdan 2-3 matnli navbat. */
function TryPanel({ api, draft }: { api: TrainingApi; draft: Obj }): JSX.Element {
  const presentation = usePresentation();
  const seller = useMemo<SellerProfile>(() => {
    try {
      const raw = window.localStorage.getItem('mq-seller-profile');
      const p = raw ? (JSON.parse(raw) as Partial<SellerProfile>) : {};
      if (p.name && (p.gender === 'male' || p.gender === 'female') && p.age) return p as SellerProfile;
    } catch {
      // xotira yopiq
    }
    return { name: 'Sotuvchi', gender: 'male', age: 25 };
  }, []);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [persona, setPersona] = useState<unknown>(undefined);
  const [state, setState] = useState<unknown>(undefined);
  const [last, setLast] = useState<TryTurnResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const turns = transcript.filter((t) => t.speaker === 'seller').length;

  async function send(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.tryScenario({
        scenario: { ...draft, id: String(draft.id ?? 'qoralama') },
        seller,
        ...(persona ? { persona } : {}),
        ...(state ? { state } : {}),
        transcript,
        sellerText: text,
      });
      const base = r.openingLine ? [{ speaker: 'customer' as const, text: r.openingLine }] : [];
      setTranscript([...(transcript.length ? transcript : base), { speaker: 'seller', text }, { speaker: 'customer', text: r.customerReply }]);
      setPersona(r.persona);
      setState(r.state);
      setLast(r);
      setText('');
    } catch (e) {
      const body = (e as { body?: { issues?: ScenarioIssue[] } }).body;
      setErr(body?.issues?.length ? "Avval formadagi xatolarni tuzating." : errorText(e, presentation));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mq-panel" style={{ marginTop: 16 }}>
      <h2 className="mq-h2">Sinab ko'rish (saqlanmaydi)</h2>
      <p className="mq-small mq-muted">
        Siz: {seller.name}, {seller.gender === 'female' ? 'ayol' : 'erkak'}, {seller.age} yosh · {TRY_LIMIT} navbatgacha.
      </p>
      {transcript.map((t, i) => (
        <div key={i} className="mq-small">
          <b>{t.speaker === 'seller' ? 'Siz' : 'Mijoz'}:</b> {t.text}
        </div>
      ))}
      {last ? (
        <p className="mq-small mq-muted">
          jahl {last.state.emotion?.anger ?? '-'} · ishonch {last.state.trust} · qiziqish {last.state.interest} · sabr {last.state.patience} · forma{' '}
          {last.state.emotion?.formality ?? 'siz'}
          {last.meta.warnedNow ? " · ⚠ go'shak haqida ogohlantirdi" : ''}
          {last.meta.revealedNow ? ' · yashirin sabab ochildi' : ''}
          {last.ended ? ` · TUGADI (${last.endReason})` : ''}
        </p>
      ) : null}
      {err ? <Notice kind="error">{err}</Notice> : null}
      <div className="mq-btn-row">
        <input style={{ flex: 1 }} value={text} placeholder="Sotuvchi sifatida yozing…" onChange={(e) => setText(e.target.value)} />
        <button
          type="button"
          className="mq-btn"
          disabled={busy || !text.trim() || turns >= TRY_LIMIT || last?.ended === true}
          onClick={() => void send()}
        >
          {busy ? '…' : 'Yuborish'}
        </button>
        <button
          type="button"
          className="mq-btn mq-small"
          onClick={() => {
            setTranscript([]);
            setPersona(undefined);
            setState(undefined);
            setLast(null);
          }}
        >
          Qayta boshlash
        </button>
      </div>
    </section>
  );
}

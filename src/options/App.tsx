import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { describeError, testProfile } from '../shared/api';
import {
  ASR_LANGUAGES,
  PROVIDER_PRESETS,
  TARGET_LANGUAGES,
  WHISPER_MODELS,
} from '../shared/constants';
import {
  DEFAULT_SETTINGS,
  createId,
  createProfile,
  getActiveProfile,
  loadSettings,
  saveSettings,
} from '../shared/settings';
import type {
  AiProfile,
  AppSettings,
  AsrSettings,
  InferenceDevice,
  ModelHost,
  OverlaySettings,
} from '../shared/types';
import { Logo } from '../ui/brand';
import {
  CaptionIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  PlayIcon,
  PlusIcon,
  ResetIcon,
  ShieldIcon,
  SlidersIcon,
  SparkIcon,
  TrashIcon,
  WaveIcon,
} from '../ui/icons';

const SECTIONS = [
  {
    id: 'ai',
    label: 'AI 翻译',
    title: 'AI 翻译引擎',
    desc: '管理多组 OpenAI 兼容接口，实时把识别文字翻译成目标语言。正在使用的配置会对下一次翻译立即生效。',
    icon: SparkIcon,
    eyebrow: 'Translation',
  },
  {
    id: 'asr',
    label: '语音识别',
    title: '语音识别',
    desc: '选择本地 Whisper 或你自己的 ASR 接口。本地模式无需上传音频，首次使用需要下载模型。',
    icon: WaveIcon,
    eyebrow: 'Speech',
  },
  {
    id: 'appearance',
    label: '字幕外观',
    title: '字幕外观',
    desc: '调整字号、配色、背景与位置。所有改动都会实时同步到已打开的视频页面。',
    icon: CaptionIcon,
    eyebrow: 'Appearance',
  },
  {
    id: 'general',
    label: '通用设置',
    title: '通用设置',
    desc: '设置翻译目标语言、查看使用方式与隐私说明，或恢复默认配置。',
    icon: SlidersIcon,
    eyebrow: 'General',
  },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];
type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type Updater = (mutate: (draft: AppSettings) => void, immediate?: boolean) => void;

interface SectionProps {
  settings: AppSettings;
  update: Updater;
}

const FONT_OPTIONS = [
  { value: DEFAULT_SETTINGS.overlay.fontFamily, label: '系统默认' },
  {
    value:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif',
    label: '无衬线（黑体）',
  },
  {
    value: '"Songti SC", "SimSun", "Noto Serif SC", "Source Han Serif SC", serif',
    label: '衬线（宋体）',
  },
  {
    value: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    label: '等宽字体',
  },
];

const SAMPLE = {
  original: "We're not so different, you and I.",
  translation: '你我之间，其实并没有那么不同。',
};

function hexToRgba(hex: string, alpha: number): string {
  const cleaned = hex.replace('#', '').trim();
  let r = 8;
  let g = 19;
  let b = 16;
  if (/^[0-9a-f]{3}$/i.test(cleaned)) {
    r = parseInt(cleaned[0] + cleaned[0], 16);
    g = parseInt(cleaned[1] + cleaned[1], 16);
    b = parseInt(cleaned[2] + cleaned[2], 16);
  } else if (/^[0-9a-f]{6}$/i.test(cleaned)) {
    r = parseInt(cleaned.slice(0, 2), 16);
    g = parseInt(cleaned.slice(2, 4), 16);
    b = parseInt(cleaned.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`;
}

function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function prettyBase(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const percent = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  return (
    <div className="slider-field">
      <div className="slider-top">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{format ? format(value) : value}</span>
      </div>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ '--fill': `${percent}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, Math.round(parsed))));
    } else {
      setDraft(String(value));
    }
  };

  return (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'on' : ''}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span className="toggle-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="track" />
      </span>
    </label>
  );
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [section, setSection] = useState<SectionId>('ai');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const settingsRef = useRef<AppSettings | null>(null);
  const debounceRef = useRef<number | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void loadSettings()
      .then((loaded) => {
        if (!alive) return;
        settingsRef.current = loaded;
        setSettings(loaded);
      })
      .catch((error) => {
        if (!alive) return;
        const fallback = structuredClone(DEFAULT_SETTINGS);
        settingsRef.current = fallback;
        setSettings(fallback);
        setSaveState('error');
        setSaveError(describeError(error));
      });
    return () => {
      alive = false;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const saveNow = useCallback(async (next: AppSettings) => {
    setSaveState('saving');
    try {
      await saveSettings(next);
      setSaveState('saved');
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = window.setTimeout(() => setSaveState('idle'), 2200);
    } catch (error) {
      setSaveState('error');
      setSaveError(describeError(error));
    }
  }, []);

  const update = useCallback<Updater>(
    (mutate, immediate = false) => {
      const base = settingsRef.current;
      if (!base) return;
      const next = structuredClone(base);
      mutate(next);
      settingsRef.current = next;
      setSettings(next);
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setSaveState('saving');
      if (immediate) {
        void saveNow(next);
      } else {
        debounceRef.current = window.setTimeout(() => {
          debounceRef.current = null;
          void saveNow(next);
        }, 420);
      }
    },
    [saveNow],
  );

  const meta = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0];

  if (!settings) {
    return (
      <div className="boot">
        <div className="boot-mark">
          <Logo size={42} />
        </div>
        <p>正在加载设置…</p>
      </div>
    );
  }

  return (
    <div className="opt-shell">
      <aside className="opt-sidebar">
        <div className="brand">
          <Logo size={30} />
          <div>
            <div className="brand-name">
              Transub <em>译流</em>
            </div>
            <div className="brand-sub">Live Dual Subtitles</div>
          </div>
        </div>

        <div className="nav-label">设置</div>
        <nav className="nav">
          {SECTIONS.map((item) => {
            const NavIcon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${section === item.id ? 'on' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <NavIcon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <div className="privacy-chip">
            <ShieldIcon size={15} />
            <span>
              API Key 与配置只保存在本机，
              <br />
              不会上传到任何第三方服务。
            </span>
          </div>
          <div className="version">v0.1.0 · Manifest V3</div>
        </div>
      </aside>

      <main className="opt-main">
        <header className="page-head">
          <div>
            <p className="page-eyebrow">{meta.eyebrow}</p>
            <h1 className="page-title">{meta.title}</h1>
            <p className="page-desc">{meta.desc}</p>
          </div>
          <div
            className={`save-pill ${saveState}`}
            title={saveState === 'error' ? saveError : '修改会自动保存'}
          >
            <span className="save-dot" />
            {saveState === 'saving'
              ? '保存中…'
              : saveState === 'saved'
                ? '已自动保存'
                : saveState === 'error'
                  ? '保存失败'
                  : '自动保存'}
          </div>
        </header>

        {saveState === 'error' && saveError ? (
          <div className="global-error">
            <InfoIcon size={15} />
            <span>{saveError}</span>
          </div>
        ) : null}

        <div className="page-body" key={section}>
          {section === 'ai' ? (
            <AiSection settings={settings} update={update} />
          ) : null}
          {section === 'asr' ? (
            <AsrSection settings={settings} update={update} />
          ) : null}
          {section === 'appearance' ? (
            <AppearanceSection settings={settings} update={update} />
          ) : null}
          {section === 'general' ? (
            <GeneralSection settings={settings} update={update} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function AiSection({ settings, update }: SectionProps) {
  const fallback = getActiveProfile(settings) ?? settings.profiles[0];
  const [selectedId, setSelectedId] = useState<string>(fallback?.id ?? '');
  const selected =
    settings.profiles.find((profile) => profile.id === selectedId) ?? fallback;

  if (!selected) return null;

  const handleCreate = () => {
    const profile = createProfile(`配置 ${settings.profiles.length + 1}`);
    update((draft) => {
      draft.profiles.push(profile);
    }, true);
    setSelectedId(profile.id);
  };

  const handleDuplicate = () => {
    const copy: AiProfile = {
      ...selected,
      id: createId('profile'),
      name: `${selected.name} 副本`,
    };
    update((draft) => {
      draft.profiles.push(copy);
    }, true);
    setSelectedId(copy.id);
  };

  const handleDelete = () => {
    if (settings.profiles.length <= 1) return;
    const index = settings.profiles.findIndex((item) => item.id === selected.id);
    const remaining = settings.profiles.filter((item) => item.id !== selected.id);
    const nextSelected = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
    update((draft) => {
      draft.profiles = draft.profiles.filter((item) => item.id !== selected.id);
      if (draft.activeProfileId === selected.id) {
        draft.activeProfileId = draft.profiles[0].id;
      }
    }, true);
    setSelectedId(nextSelected.id);
  };

  const patchProfile = (patch: Partial<AiProfile>) => {
    update((draft) => {
      const target = draft.profiles.find((item) => item.id === selected.id);
      if (target) Object.assign(target, patch);
    });
  };

  return (
    <div className="profiles-layout">
      <aside className="card profile-list-card">
        <div className="profile-list-head">
          <span>配置列表</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="新建配置"
            title="新建配置"
            onClick={handleCreate}
          >
            <PlusIcon size={16} />
          </button>
        </div>

        <div className="profile-list">
          {settings.profiles.map((profile) => {
            const active = profile.id === settings.activeProfileId;
            return (
              <button
                key={profile.id}
                type="button"
                className={`profile-item ${profile.id === selected.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(profile.id)}
                title={profile.name}
              >
                <span className="profile-avatar">
                  {(profile.name.trim().slice(0, 1) || 'A').toUpperCase()}
                </span>
                <span className="profile-item-body">
                  <span className="profile-item-name">
                    <span className="name-text">{profile.name}</span>
                  </span>
                  <span className="profile-item-url">
                    {profile.model || '未设置模型'} · {prettyBase(profile.baseUrl) || '未设置地址'}
                  </span>
                </span>
                {active ? <span className="live-dot" title="使用中" /> : null}
              </button>
            );
          })}
        </div>

        <button type="button" className="btn ghost small new-profile" onClick={handleCreate}>
          <PlusIcon size={14} />
          新建配置
        </button>
        <p className="profile-tip">绿色圆点表示正在使用的配置，切换后立刻对下一次翻译生效。</p>
      </aside>

      <ProfileEditor
        key={selected.id}
        profile={selected}
        isActive={selected.id === settings.activeProfileId}
        canDelete={settings.profiles.length > 1}
        onChange={patchProfile}
        onActivate={() =>
          update((draft) => {
            draft.activeProfileId = selected.id;
          }, true)
        }
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
      />
    </div>
  );
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; message: string }
  | { phase: 'error'; message: string };

function ProfileEditor({
  profile,
  isActive,
  canDelete,
  onChange,
  onActivate,
  onDuplicate,
  onDelete,
}: {
  profile: AiProfile;
  isActive: boolean;
  canDelete: boolean;
  onChange: (patch: Partial<AiProfile>) => void;
  onActivate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [revealKey, setRevealKey] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const change = (patch: Partial<AiProfile>) => {
    if (test.phase !== 'idle') setTest({ phase: 'idle' });
    if (confirmDelete) setConfirmDelete(false);
    onChange(patch);
  };

  const preset = PROVIDER_PRESETS.find(
    (item) =>
      item.id !== 'custom' &&
      item.baseUrl.replace(/\/+$/, '') === profile.baseUrl.replace(/\/+$/, ''),
  );

  const runTest = async () => {
    setTest({ phase: 'testing' });
    try {
      const result = await testProfile(profile);
      setTest({
        phase: 'ok',
        message: `连接成功 · ${result.latencyMs} ms · 模型回复「${result.reply.slice(0, 40)}」`,
      });
    } catch (error) {
      setTest({ phase: 'error', message: describeError(error) });
    }
  };

  return (
    <section className="card profile-editor">
      <div className="profile-head">
        <div className="profile-head-copy">
          <div className="profile-title-row">
            <h2>{profile.name || '未命名配置'}</h2>
            {isActive ? <span className="badge-live">使用中</span> : null}
          </div>
          <p className="profile-sub">
            {profile.model || '尚未设置模型'}
            {profile.baseUrl ? ` · ${prettyBase(profile.baseUrl)}` : ''}
          </p>
        </div>
        {!isActive ? (
          <button type="button" className="btn small" onClick={onActivate}>
            <CheckIcon size={14} />
            使用此配置
          </button>
        ) : null}
      </div>

      <div className="form-grid">
        <div className="field span-2">
          <span className="field-label">服务商预设</span>
          <div className="preset-row">
            {PROVIDER_PRESETS.filter((item) => item.id !== 'custom').map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip ${preset?.id === item.id ? 'on' : ''}`}
                onClick={() => change({ baseUrl: item.baseUrl, model: item.model })}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="field-hint">
            {preset?.hint ||
              '预设只填入接口地址与模型名称，不会覆盖你的配置名称、API Key 或高级参数。'}
          </p>
        </div>

        <label className="field span-2">
          <span className="field-label">API Base URL</span>
          <input
            className="input"
            type="text"
            value={profile.baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder="https://api.openai.com/v1"
            onChange={(event) => change({ baseUrl: event.target.value })}
          />
          <span className="field-hint">
            支持任意 OpenAI 兼容接口。填到 /v1 即可，会自动补全 /chat/completions。
          </span>
        </label>

        <label className="field span-2">
          <span className="field-label">API Key</span>
          <span className="input-group">
            <input
              className="input"
              type={revealKey ? 'text' : 'password'}
              value={profile.apiKey}
              spellCheck={false}
              autoComplete="off"
              placeholder="sk-...（Ollama 等本地接口可留空）"
              onChange={(event) => change({ apiKey: event.target.value })}
            />
            <button
              type="button"
              className="input-affix"
              aria-label={revealKey ? '隐藏 API Key' : '显示 API Key'}
              title={revealKey ? '隐藏 API Key' : '显示 API Key'}
              onClick={() => setRevealKey((value) => !value)}
            >
              {revealKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
            </button>
          </span>
          <span className="field-hint">密钥仅保存在本机 chrome.storage.local。</span>
        </label>

        <label className="field">
          <span className="field-label">配置名称</span>
          <input
            className="input"
            type="text"
            value={profile.name}
            placeholder="例如：DeepSeek 主力"
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">模型名称</span>
          <input
            className="input"
            type="text"
            value={profile.model}
            spellCheck={false}
            autoComplete="off"
            placeholder="gpt-4o-mini / deepseek-chat / qwen2.5"
            onChange={(event) => change({ model: event.target.value })}
          />
        </label>

        <RangeField
          label="温度"
          value={profile.temperature}
          min={0}
          max={2}
          step={0.1}
          format={(value) => value.toFixed(1)}
          hint="越低越稳定，字幕翻译建议 0.1–0.3。"
          onChange={(value) => change({ temperature: value })}
        />

        <div className="field">
          <span className="field-label">最大输出 tokens</span>
          <NumberInput
            value={profile.maxTokens}
            min={64}
            max={32768}
            step={64}
            onChange={(value) => change({ maxTokens: value })}
          />
          <span className="field-hint">单条字幕通常很短，800 已足够。</span>
        </div>
      </div>

      <details className="advanced">
        <summary>高级：自定义翻译提示词</summary>
        <div className="advanced-body">
          <textarea
            className="textarea"
            value={profile.customPrompt}
            placeholder="例如：保留英文技术术语；译文尽量简短，适配合成器口型；不要使用书面语。"
            onChange={(event) => change({ customPrompt: event.target.value })}
          />
          <p className="field-hint">
            会追加到系统提示词，对当前配置下的所有翻译生效。留空则使用默认影视字幕风格。
          </p>
        </div>
      </details>

      {test.phase === 'ok' ? (
        <div className="test-banner ok">
          <CheckIcon size={15} />
          <span>{test.message}</span>
        </div>
      ) : null}
      {test.phase === 'error' ? (
        <div className="test-banner error">
          <InfoIcon size={15} />
          <span>{test.message}</span>
        </div>
      ) : null}

      <div className="editor-actions">
        <div className="action-group">
          <button
            type="button"
            className="btn"
            disabled={test.phase === 'testing'}
            onClick={() => void runTest()}
          >
            {test.phase === 'testing' ? (
              <span className="spinner" />
            ) : (
              <PlayIcon size={14} />
            )}
            {test.phase === 'testing' ? '测试中…' : '测试连接'}
          </button>
        </div>
        <div className="action-group">
          <button type="button" className="btn ghost small" onClick={onDuplicate}>
            <CopyIcon size={14} />
            复制配置
          </button>
          <button
            type="button"
            className={`btn ghost small ${confirmDelete ? 'danger' : ''}`}
            disabled={!canDelete}
            title={canDelete ? '删除此配置' : '至少保留一组配置'}
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                return;
              }
              setConfirmDelete(false);
              onDelete();
            }}
          >
            <TrashIcon size={14} />
            {confirmDelete ? '再次点击确认删除' : '删除'}
          </button>
        </div>
      </div>
    </section>
  );
}

function AsrSection({ settings, update }: SectionProps) {
  const { asr } = settings;
  const [revealKey, setRevealKey] = useState(false);

  const patch = (values: Partial<AsrSettings>, immediate = false) => {
    update((draft) => {
      Object.assign(draft.asr, values);
    }, immediate);
  };

  const languageSelect = (
    <label className="field">
      <span className="field-label">识别语言</span>
      <select
        className="select"
        value={asr.language}
        onChange={(event) => patch({ language: event.target.value })}
      >
        {ASR_LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.label}
          </option>
        ))}
      </select>
      <span className="field-hint">
        指定语言通常比自动检测更准确；混合语言视频建议保持自动。
      </span>
    </label>
  );

  return (
    <>
      <section className="card card-pad">
        <div className="block-head">
          <div>
            <h3>识别方式</h3>
            <p>音频优先在本地处理；只有远程模式才会把音频片段发出去。</p>
          </div>
        </div>
        <div className="choice-grid">
          <button
            type="button"
            className={`choice ${asr.engine === 'local' ? 'on' : ''}`}
            aria-pressed={asr.engine === 'local'}
            onClick={() => patch({ engine: 'local' }, true)}
          >
            <span className="choice-top">
              <span className="choice-icon">
                <WaveIcon size={17} />
              </span>
              <span className="choice-name">本地 Whisper</span>
              <span className="choice-badge">推荐</span>
            </span>
            <span className="choice-desc">
              在浏览器内用 WebGPU / WASM 识别，音频不离开设备。首次使用需下载模型。
            </span>
            <span className="choice-radio" />
          </button>

          <button
            type="button"
            className={`choice ${asr.engine === 'remote' ? 'on' : ''}`}
            aria-pressed={asr.engine === 'remote'}
            onClick={() => patch({ engine: 'remote' }, true)}
          >
            <span className="choice-top">
              <span className="choice-icon">
                <SparkIcon size={17} />
              </span>
              <span className="choice-name">远程 ASR 接口</span>
            </span>
            <span className="choice-desc">
              调用你自己的 OpenAI 兼容 /audio/transcriptions 接口，速度取决于服务器。
            </span>
            <span className="choice-radio" />
          </button>
        </div>
      </section>

      {asr.engine === 'local' ? (
        <>
          <section className="card card-pad">
            <div className="block-head">
              <div>
                <h3>Whisper 模型</h3>
                <p>模型越大越准确，但首次下载和识别耗时也越长。</p>
              </div>
            </div>

            <div className="model-grid">
              {WHISPER_MODELS.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`model-card ${asr.localModel === model.id ? 'on' : ''}`}
                  aria-pressed={asr.localModel === model.id}
                  onClick={() => patch({ localModel: model.id }, true)}
                >
                  <span className="model-name">
                    {model.label}
                    {model.id === 'base' ? <span className="tag">均衡</span> : null}
                  </span>
                  <span className="model-meta">
                    {model.params} 参数 · {model.download}
                  </span>
                  <span className="model-desc">{model.description}</span>
                  <span className="choice-radio" />
                </button>
              ))}
            </div>

            <div className="asr-form-grid">
              <div className="field">
                <span className="field-label">推理设备</span>
                <Segmented<InferenceDevice>
                  value={asr.localDevice}
                  ariaLabel="推理设备"
                  options={[
                    { value: 'auto', label: '自动' },
                    { value: 'webgpu', label: 'WebGPU' },
                    { value: 'wasm', label: 'WASM' },
                  ]}
                  onChange={(value) => patch({ localDevice: value }, true)}
                />
                <span className="field-hint">自动会优先尝试 WebGPU，失败时回退 WASM。</span>
              </div>

              <div className="field">
                <span className="field-label">模型下载源</span>
                <Segmented<ModelHost>
                  value={asr.modelHost}
                  ariaLabel="模型下载源"
                  options={[
                    { value: 'huggingface', label: 'Hugging Face' },
                    { value: 'hf-mirror', label: '国内镜像' },
                  ]}
                  onChange={(value) => patch({ modelHost: value }, true)}
                />
                <span className="field-hint">无法访问 Hugging Face 时切换到 hf-mirror。</span>
              </div>
            </div>

            {languageSelect}

            <div className="callout">
              <InfoIcon size={15} />
              <span>
                首次识别时会下载并缓存模型（Tiny 约 40–75 MB）。下载期间请保持页面打开；模型会保存在浏览器缓存中，下次秒开。
              </span>
            </div>
          </section>
        </>
      ) : (
        <section className="card card-pad">
          <div className="block-head">
            <div>
              <h3>远程 ASR 接口</h3>
              <p>使用 OpenAI 兼容的 /v1/audio/transcriptions 接口。</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field span-2">
              <span className="field-label">ASR Base URL</span>
              <input
                className="input"
                type="text"
                value={asr.remoteBaseUrl}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://api.openai.com/v1"
                onChange={(event) => patch({ remoteBaseUrl: event.target.value })}
              />
              <span className="field-hint">
                填到 /v1 即可，会自动补全 /audio/transcriptions。
              </span>
            </label>

            <label className="field span-2">
              <span className="field-label">ASR API Key</span>
              <span className="input-group">
                <input
                  className="input"
                  type={revealKey ? 'text' : 'password'}
                  value={asr.remoteApiKey}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="sk-...（本地服务可留空）"
                  onChange={(event) => patch({ remoteApiKey: event.target.value })}
                />
                <button
                  type="button"
                  className="input-affix"
                  aria-label={revealKey ? '隐藏 ASR Key' : '显示 ASR Key'}
                  title={revealKey ? '隐藏 ASR Key' : '显示 ASR Key'}
                  onClick={() => setRevealKey((value) => !value)}
                >
                  {revealKey ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
                </button>
              </span>
            </label>

            <label className="field span-2">
              <span className="field-label">ASR 模型</span>
              <input
                className="input"
                type="text"
                value={asr.remoteModel}
                spellCheck={false}
                autoComplete="off"
                placeholder="whisper-1 / whisper-large-v3-turbo"
                onChange={(event) => patch({ remoteModel: event.target.value })}
              />
              <span className="field-hint">
                例如 OpenAI 的 whisper-1、Groq 的 whisper-large-v3-turbo，或自建 faster-whisper 网关。
              </span>
            </label>

            {languageSelect}
          </div>

          <div className="callout warn">
            <InfoIcon size={15} />
            <span>
              远程模式会把切分后的音频片段上传到你配置的 ASR 服务。请确认你信任该服务，并了解其计费方式。
            </span>
          </div>
        </section>
      )}
    </>
  );
}

function AppearanceSection({ settings, update }: SectionProps) {
  const overlay = settings.overlay;

  const patch = (values: Partial<OverlaySettings>, immediate = false) => {
    update((draft) => {
      draft.overlay = { ...draft.overlay, ...values };
    }, immediate);
  };

  const previewStyle: CSSProperties = {
    left: `${overlay.positionX}%`,
    top: `${overlay.positionY}%`,
    maxWidth: `${overlay.maxWidth}%`,
    background: hexToRgba(overlay.background, overlay.backgroundOpacity),
    fontFamily: overlay.fontFamily,
  };

  const anyVisible = overlay.showOriginal || overlay.showTranslation;

  return (
    <>
      <section className="card preview-card">
        <div className="preview">
          <div className="preview-art" />
          <span className="preview-badge">字幕预览</span>
          {anyVisible ? (
            <div className="preview-caption" style={previewStyle}>
              {overlay.showOriginal ? (
                <div
                  className="preview-original"
                  style={{
                    color: overlay.originalColor,
                    fontSize: `${Math.min(overlay.originalSize, 30)}px`,
                  }}
                >
                  {SAMPLE.original}
                </div>
              ) : null}
              {overlay.showTranslation ? (
                <div
                  className="preview-translation"
                  style={{
                    color: overlay.translationColor,
                    fontSize: `${Math.min(overlay.translationSize, 28)}px`,
                  }}
                >
                  {SAMPLE.translation}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="preview-empty">原文与译文都已隐藏</div>
          )}
        </div>

        <div className="preview-foot">
          <p className="preview-hint">
            拖动视频上的字幕条即可移动位置，Shift + 滚轮可快速缩放字号。
          </p>
          <div className="preview-toggles">
            <label className="inline-toggle">
              <span>原文</span>
              <span className="switch sm">
                <input
                  type="checkbox"
                  checked={overlay.showOriginal}
                  onChange={(event) => patch({ showOriginal: event.target.checked }, true)}
                />
                <span className="track" />
              </span>
            </label>
            <label className="inline-toggle">
              <span>译文</span>
              <span className="switch sm">
                <input
                  type="checkbox"
                  checked={overlay.showTranslation}
                  onChange={(event) =>
                    patch({ showTranslation: event.target.checked }, true)
                  }
                />
                <span className="track" />
              </span>
            </label>
          </div>
        </div>
      </section>

      <div className="style-columns">
        <section className="card panel">
          <h3 className="panel-title">
            <CaptionIcon size={16} />
            字体与排版
          </h3>

          <label className="field">
            <span className="field-label">字幕字体</span>
            <select
              className="select"
              value={overlay.fontFamily}
              onChange={(event) => patch({ fontFamily: event.target.value }, true)}
            >
              {FONT_OPTIONS.map((font) => (
                <option key={font.label} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>

          <RangeField
            label="原文字号"
            value={overlay.originalSize}
            min={12}
            max={64}
            format={(value) => `${value}px`}
            onChange={(value) => patch({ originalSize: value })}
          />
          <RangeField
            label="译文字号"
            value={overlay.translationSize}
            min={10}
            max={64}
            format={(value) => `${value}px`}
            onChange={(value) => patch({ translationSize: value })}
          />
          <RangeField
            label="字幕最大宽度"
            value={overlay.maxWidth}
            min={30}
            max={98}
            format={(value) => `${value}%`}
            onChange={(value) => patch({ maxWidth: value })}
          />
          <RangeField
            label="停止说话后隐藏"
            value={overlay.hideDelay}
            min={0}
            max={20}
            format={(value) => (value === 0 ? '不隐藏' : `${value} 秒`)}
            hint="设为 0 时字幕会一直保留到下一句。"
            onChange={(value) => patch({ hideDelay: value })}
          />
        </section>

        <section className="card panel">
          <h3 className="panel-title">
            <SlidersIcon size={16} />
            颜色与背景
          </h3>

          <div className="color-grid">
            <ColorControl
              label="原文"
              value={overlay.originalColor}
              fallback={DEFAULT_SETTINGS.overlay.originalColor}
              onChange={(value) => patch({ originalColor: value })}
            />
            <ColorControl
              label="译文"
              value={overlay.translationColor}
              fallback={DEFAULT_SETTINGS.overlay.translationColor}
              onChange={(value) => patch({ translationColor: value })}
            />
            <ColorControl
              label="背景"
              value={overlay.background}
              fallback={DEFAULT_SETTINGS.overlay.background}
              onChange={(value) => patch({ background: value })}
            />
          </div>

          <RangeField
            label="背景不透明度"
            value={Math.round(overlay.backgroundOpacity * 100)}
            min={0}
            max={100}
            format={(value) => `${value}%`}
            hint="0% 完全透明，只保留文字阴影。"
            onChange={(value) => patch({ backgroundOpacity: value / 100 })}
          />

          <div className="mini-stage" aria-hidden="true">
            <span
              className="mini-stage-caption"
              style={{
                color: overlay.originalColor,
                background: hexToRgba(overlay.background, overlay.backgroundOpacity),
                fontFamily: overlay.fontFamily,
              }}
            >
              双语字幕
            </span>
          </div>
        </section>
      </div>

      <section className="card panel">
        <h3 className="panel-title">
          <ResetIcon size={16} />
          位置
        </h3>
        <div className="position-grid">
          <RangeField
            label="水平位置"
            value={overlay.positionX}
            min={2}
            max={98}
            format={(value) => `${value}%`}
            onChange={(value) => patch({ positionX: value })}
          />
          <RangeField
            label="垂直位置"
            value={overlay.positionY}
            min={2}
            max={98}
            format={(value) => `${value}%`}
            onChange={(value) => patch({ positionY: value })}
          />
        </div>
        <div className="position-foot">
          <p className="field-hint">
            位置使用视口百分比。建议底部字幕保持在 75%–90% 之间，避免被播放器控件遮挡。
          </p>
          <button
            type="button"
            className="btn ghost small"
            onClick={() =>
              patch(
                {
                  positionX: DEFAULT_SETTINGS.overlay.positionX,
                  positionY: DEFAULT_SETTINGS.overlay.positionY,
                },
                true,
              )
            }
          >
            <ResetIcon size={14} />
            恢复默认位置
          </button>
        </div>
      </section>
    </>
  );
}

function ColorControl({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const color = safeColor(value, fallback);
  return (
    <label className="color-control">
      <span className="color-label">{label}</span>
      <span className="color-bottom">
        <span className="color-hex">{color.toUpperCase()}</span>
        <input
          type="color"
          className="color-swatch"
          value={color}
          aria-label={`${label}颜色`}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
    </label>
  );
}

function GeneralSection({ settings, update }: SectionProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const { translation } = settings;

  const patchTranslation = (
    values: Partial<AppSettings['translation']>,
    immediate = false,
  ) => {
    update((draft) => {
      Object.assign(draft.translation, values);
    }, immediate);
  };

  return (
    <>
      <div className="general-grid">
        <section className="card panel">
          <h3 className="panel-title">
            <SparkIcon size={16} />
            翻译
          </h3>

          <ToggleRow
            title="启用 AI 翻译"
            description={
              translation.enabled
                ? '识别到语音后，实时调用当前 AI 配置生成译文。'
                : '关闭后只显示原文，不产生任何 AI 请求。'
            }
            checked={translation.enabled}
            onChange={(value) => patchTranslation({ enabled: value }, true)}
          />

          <label className="field">
            <span className="field-label">目标语言</span>
            <select
              className="select"
              value={translation.targetLanguage}
              onChange={(event) =>
                patchTranslation({ targetLanguage: event.target.value }, true)
              }
            >
              {TARGET_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>

          {translation.targetLanguage === 'custom' ? (
            <label className="field">
              <span className="field-label">自定义目标</span>
              <input
                className="input"
                type="text"
                value={translation.customTarget}
                placeholder="例如：粤语口语 / 印尼语"
                onChange={(event) =>
                  patchTranslation({ customTarget: event.target.value })
                }
              />
              <span className="field-hint">
                这段文字会直接写入翻译提示词，建议使用明确的语言名称。
              </span>
            </label>
          ) : (
            <p className="field-hint">
              「自动 · 中英互译」会根据原文在中英之间切换，适合两种语言混合的视频。
            </p>
          )}
        </section>

        <section className="card panel">
          <h3 className="panel-title">
            <PlayIcon size={16} />
            使用步骤
          </h3>
          <ol className="steps">
            <li>
              <span className="step-num">1</span>
              <span>打开任意有声音的视频页面；本地文件需要在扩展详情里开启「允许访问文件网址」。</span>
            </li>
            <li>
              <span className="step-num">2</span>
              <span>点击扩展图标，确认 AI 与语音识别配置后点击「开始双语字幕」。</span>
            </li>
            <li>
              <span className="step-num">3</span>
              <span>播放视频，双语字幕会叠加在播放器上方；可拖动字幕条调整位置。</span>
            </li>
            <li>
              <span className="step-num">4</span>
              <span>在弹窗中随时停止并导出 SRT / VTT / TXT 字幕文件。</span>
            </li>
          </ol>
        </section>
      </div>

      <div className="general-grid">
        <section className="card panel">
          <h3 className="panel-title">
            <ShieldIcon size={16} />
            隐私与数据
          </h3>
          <ul className="bullets">
            <li>
              <CheckIcon size={14} />
              <span>AI 配置、API Key 与字幕记录只保存在本机浏览器存储中。</span>
            </li>
            <li>
              <CheckIcon size={14} />
              <span>本地 Whisper 模式下，音频完全在浏览器内处理，不会上传。</span>
            </li>
            <li>
              <CheckIcon size={14} />
              <span>远程 ASR 会发送音频片段；AI 翻译会发送字幕文本，均只发往你填写的接口。</span>
            </li>
            <li>
              <CheckIcon size={14} />
              <span>不包含统计、埋点或任何第三方遥测。</span>
            </li>
          </ul>
        </section>

        <section className="card panel danger-card">
          <h3 className="panel-title">
            <ResetIcon size={16} />
            恢复默认设置
          </h3>
          <p className="field-hint">
            会重置全部配置、AI 密钥、字幕样式与识别选项。已下载的 Whisper 模型缓存不会被删除。
          </p>
          <button
            type="button"
            className={`btn ${confirmReset ? 'danger' : ''}`}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              update((draft) => {
                Object.assign(draft, structuredClone(DEFAULT_SETTINGS));
              }, true);
              setConfirmReset(false);
            }}
          >
            <ResetIcon size={14} />
            {confirmReset ? '再次点击确认恢复' : '恢复默认设置'}
          </button>
        </section>
      </div>
    </>
  );
}

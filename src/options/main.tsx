import { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_MODEL, type ExtensionSettings } from '../types/messages';
import './options.css';

function OptionsApp() {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get(['apiKey', 'model']).then((value: Partial<ExtensionSettings>) => {
      setApiKey(value.apiKey ?? '');
      setModel(value.model || DEFAULT_MODEL);
    });
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    await chrome.storage.local.set({ apiKey: apiKey.trim(), model: model.trim() || DEFAULT_MODEL });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <main>
      <div className="brand">Structured Response Canvas</div>
      <section>
        <h1>Settings</h1>
        <p className="intro">Connect your own OpenAI API account to structure the response you choose.</p>
        <form onSubmit={save}>
          <label htmlFor="apiKey">OpenAI API key</label>
          <input id="apiKey" type="password" autoComplete="off" placeholder="sk-..." value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
          <p className="help">Stored locally in this Chrome profile. It is read only by the extension service worker and is never inserted into the ChatGPT page.</p>
          <label htmlFor="model">Model</label>
          <input id="model" value={model} onChange={(event) => setModel(event.target.value)} />
          <p className="help">The default favors speed and cost. You can enter another model available to your API account.</p>
          <button type="submit">Save settings</button>
          <span className={`saved ${saved ? 'visible' : ''}`}>Saved</span>
        </form>
      </section>
      <p className="privacy">The extension reads only the Assistant response for which you click Structure. It does not read other messages, drafts, cookies, or account data.</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<OptionsApp />);

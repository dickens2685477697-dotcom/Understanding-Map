import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Structured Response Canvas',
  description: 'Turn a ChatGPT response into a navigable semantic canvas.',
  version: '0.1.0',
  permissions: ['storage'],
  host_permissions: ['https://api.openai.com/*'],
  background: { service_worker: 'src/background/serviceWorker.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['https://chatgpt.com/*'],
      js: ['src/content/contentScript.tsx'],
      run_at: 'document_idle',
    },
  ],
  options_ui: { page: 'src/options/index.html', open_in_tab: true },
  action: { default_title: 'Structured Response Canvas' },
});

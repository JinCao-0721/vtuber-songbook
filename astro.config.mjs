import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'https://example.com',
  devToolbar: { enabled: false },
});

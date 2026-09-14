export const siteId = import.meta.env.PUBLIC_SITE_ID || 'ii7';

const profiles: Record<string, { name: string; subtitle: string; domain: string }> = {
  ii7: { name: 'ii7', subtitle: 'VTUBER SONGBOOK', domain: 'ii7.example.com' },
};

export const profile = profiles[siteId] || {
  name: siteId,
  subtitle: 'VTUBER SONGBOOK',
  domain: `${siteId}.example.com`,
};

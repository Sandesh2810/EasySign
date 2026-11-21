// D-96: the web app manifest, so a signer can add YouNMeSign to their phone's home screen. It opens the signing page
// (which resumes a signing session that is still open, or says to open the link from the email again). Nothing about a
// document is stored by installing it; see public/sw.js.
import type { MetadataRoute } from 'next';
import { PRODUCT_NAME } from '@/config/brand';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/sign',
    name: `${PRODUCT_NAME} signing`,
    short_name: PRODUCT_NAME,
    description: 'Review and sign documents sent to you.',
    start_url: '/sign',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a1818',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

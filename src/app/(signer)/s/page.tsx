import type { Metadata } from 'next';
import { OpenLink } from './open-link';

export const metadata: Metadata = { title: 'Opening your document' };

// The signing link is /s#<token>. The part after "#" never reaches the server with the page request;
// the small script on this page hands it over in a POST body and then removes it from the address bar.
export default function SignerEntryPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <OpenLink />
    </div>
  );
}

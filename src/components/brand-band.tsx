// D-88: a workspace's branding above the signing surface (which itself stays neutral and high-contrast):
// its logo and name on its brand colour. The colour pair passed the 4.5:1 contrast check when it was saved.
import type { WorkspaceBrand } from '@/lib/branding-store';

export function BrandBand({ brand }: { brand: WorkspaceBrand }) {
  return (
    <div style={{ backgroundColor: brand.color, color: brand.textColor }} data-brand-band="">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        {brand.logoVersion ? (
          // eslint-disable-next-line @next/next/no-img-element -- a small logo from our own route; no image optimisation needed
          <img src={`/api/brand/${brand.orgId}/logo?v=${brand.logoVersion}`} alt={`${brand.name} logo`} className="h-10 w-auto max-w-[10rem] object-contain" />
        ) : null}
        <p className="text-base font-medium [overflow-wrap:anywhere]">{brand.name}</p>
      </div>
    </div>
  );
}

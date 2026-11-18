import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normaliseRotation, normaliseBox, displaySize, pointToPdf, pdfToPoint, rectToPdf, type PageBox } from './geometry';

const letter = (rotate: 0 | 90 | 180 | 270, x = 0, y = 0): PageBox => ({ x, y, width: 612, height: 792, rotate });

describe('normaliseRotation', () => {
  it('maps any multiple of 90 into 0/90/180/270', () => {
    expect(normaliseRotation(0)).toBe(0);
    expect(normaliseRotation(450)).toBe(90);
    expect(normaliseRotation(-90)).toBe(270);
    expect(normaliseRotation(-180)).toBe(180);
    expect(normaliseRotation(720)).toBe(0);
    expect(normaliseRotation(undefined)).toBe(0);
  });
  it('rejects angles that are not multiples of 90', () => {
    expect(() => normaliseRotation(45)).toThrow();
  });
});

describe('normaliseBox', () => {
  it('uses the crop box clipped to the media box', () => {
    expect(normaliseBox([0, 0, 612, 792], [50, 60, 700, 700], 0)).toEqual({ x: 50, y: 60, width: 562, height: 640, rotate: 0 });
  });
  it('handles reversed corners and a missing crop box', () => {
    expect(normaliseBox([612, 792, 0, 0], undefined, 90)).toEqual({ x: 0, y: 0, width: 612, height: 792, rotate: 90 });
  });
  it('rejects an empty box', () => {
    expect(() => normaliseBox([0, 0, 0, 792], undefined, 0)).toThrow();
  });
});

describe('displaySize', () => {
  it('swaps width and height for 90 and 270', () => {
    expect(displaySize(letter(0))).toEqual({ width: 612, height: 792 });
    expect(displaySize(letter(90))).toEqual({ width: 792, height: 612 });
    expect(displaySize(letter(270))).toEqual({ width: 792, height: 612 });
  });
});

describe('pointToPdf: display corners land on the right unrotated corners', () => {
  // Display top-left (0,0), top-right (1,0), bottom-left (0,1), bottom-right (1,1).
  const cases: Array<[0 | 90 | 180 | 270, [number, number][]]> = [
    [0, [[0, 792], [612, 792], [0, 0], [612, 0]]],
    [90, [[0, 0], [0, 792], [612, 0], [612, 792]]],
    [180, [[612, 0], [0, 0], [612, 792], [0, 792]]],
    [270, [[612, 792], [612, 0], [0, 792], [0, 0]]],
  ];
  for (const [rot, expected] of cases) {
    it(`rotate ${rot}`, () => {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => pointToPdf(letter(rot), u, v));
      expect(pts.map((p) => [p.x, p.y])).toEqual(expected);
    });
  }
  it('adds the crop-box origin', () => {
    expect(pointToPdf(letter(0, 36, 72), 0, 1)).toEqual({ x: 36, y: 72 });
    expect(pointToPdf(letter(90, 36, 72), 0, 0)).toEqual({ x: 36, y: 72 });
  });
});

describe('round trip', () => {
  it('pdfToPoint inverts pointToPdf for every rotation and crop', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 90, 180, 270) as fc.Arbitrary<0 | 90 | 180 | 270>,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 100, max: 2000 }),
        fc.integer({ min: 100, max: 2000 }),
        fc.integer({ min: -200, max: 200 }),
        fc.integer({ min: -200, max: 200 }),
        (rotate, u, v, width, height, x, y) => {
          const box: PageBox = { x, y, width, height, rotate };
          const p = pointToPdf(box, u, v);
          const back = pdfToPoint(box, p.x, p.y);
          expect(back.u).toBeCloseTo(u, 9);
          expect(back.v).toBeCloseTo(v, 9);
        },
      ),
    );
  });
});

describe('rectToPdf', () => {
  const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };

  it('rotate 0: plain flip of the y axis', () => {
    const r = rectToPdf(letter(0), rect);
    expect(r.bounds.x).toBeCloseTo(61.2);
    expect(r.bounds.y).toBeCloseTo(792 * (1 - 0.25));
    expect(r.bounds.width).toBeCloseTo(183.6);
    expect(r.bounds.height).toBeCloseTo(39.6);
    expect(r.anchor.x).toBeCloseTo(61.2);
    expect(r.anchor.y).toBeCloseTo(594);
    expect(r.rotateCcwDegrees).toBe(0);
    expect(r.drawWidth).toBeCloseTo(183.6);
    expect(r.drawHeight).toBeCloseTo(39.6);
  });

  it('rotate 90: width scales by page height, height by page width, anchor is display bottom-left', () => {
    const r = rectToPdf(letter(90), rect);
    // displayed page is 792 wide x 612 tall
    expect(r.drawWidth).toBeCloseTo(0.3 * 792);
    expect(r.drawHeight).toBeCloseTo(0.05 * 612);
    expect(r.bounds.width).toBeCloseTo(0.05 * 612);
    expect(r.bounds.height).toBeCloseTo(0.3 * 792);
    expect(r.anchor.x).toBeCloseTo(0.25 * 612);
    expect(r.anchor.y).toBeCloseTo(0.1 * 792);
    expect(r.rotateCcwDegrees).toBe(90);
  });

  it('rotate 180 and 270 anchors', () => {
    const r180 = rectToPdf(letter(180), rect);
    expect(r180.anchor.x).toBeCloseTo(612 * 0.9);
    expect(r180.anchor.y).toBeCloseTo(792 * 0.25);
    expect(r180.rotateCcwDegrees).toBe(180);
    const r270 = rectToPdf(letter(270), rect);
    expect(r270.anchor.x).toBeCloseTo(612 * 0.75);
    expect(r270.anchor.y).toBeCloseTo(792 * 0.9);
    expect(r270.rotateCcwDegrees).toBe(270);
  });

  it('the drawn rectangle (anchor + rotated width/height) covers exactly the bounds, for every rotation', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 90, 180, 270) as fc.Arbitrary<0 | 90 | 180 | 270>,
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        fc.double({ min: 0.01, max: 0.4, noNaN: true }),
        fc.double({ min: 0.01, max: 0.4, noNaN: true }),
        (rotate, x, y, w, h) => {
          const r = rectToPdf(letter(rotate, 10, 20), { x, y, w, h });
          const t = (rotate * Math.PI) / 180;
          const ax = { x: Math.cos(t), y: Math.sin(t) }; // local +x after CCW rotation
          const ay = { x: -Math.sin(t), y: Math.cos(t) }; // local +y
          const far = {
            x: r.anchor.x + ax.x * r.drawWidth + ay.x * r.drawHeight,
            y: r.anchor.y + ax.y * r.drawWidth + ay.y * r.drawHeight,
          };
          expect(Math.min(r.anchor.x, far.x)).toBeCloseTo(r.bounds.x, 6);
          expect(Math.min(r.anchor.y, far.y)).toBeCloseTo(r.bounds.y, 6);
          expect(Math.abs(far.x - r.anchor.x)).toBeCloseTo(r.bounds.width, 6);
          expect(Math.abs(far.y - r.anchor.y)).toBeCloseTo(r.bounds.height, 6);
        },
      ),
    );
  });

  it('rejects rectangles outside the page', () => {
    expect(() => rectToPdf(letter(0), { x: 0.9, y: 0, w: 0.2, h: 0.1 })).toThrow();
    expect(() => rectToPdf(letter(0), { x: -0.1, y: 0, w: 0.2, h: 0.1 })).toThrow();
  });
});

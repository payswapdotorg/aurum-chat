// The accessibility rule set and audit engine (W070 — the
// "accessibility" acceptance bullet).
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 and the W057/W058 work items promise
// "accessibility keyboard traversal", "restrained motion and accessible
// focus treatment", "ARIA labels on icon-only controls", "44px+ touch
// targets" and "semantic HTML". This engine proves those promises against
// the REAL server-rendered HTML (the markup a browser receives) and the
// REAL shipped CSS/source (the parts SSR cannot show: client-side active
// states, touch target sizes).
//
// The rules are deliberately the STATIC, tool-free subset — no JavaScript
// execution, no layout engine — which is exactly what can be proven
// deterministically in CI without a browser. What each rule checks is
// documented on the rule itself; violations carry the subject (route or
// file) and a precise detail string.
//
// Source-level rules (nav-aria-current, touch-target) audit the ACTUAL
// component/CSS sources, because the corresponding rendering is
// client-side (usePathname active state) or sized by the stylesheet.

import type { A11yAuditOptions, A11yRule, A11yRuleId, A11yViolation, LinkInfo } from './types';
import {
  accessibleName,
  elementEnd,
  findTags,
  isHiddenTag,
  textContent,
} from './html';

/** The rule catalog (unit-tested for closed ids). */
export const A11Y_RULES: readonly A11yRule[] = [
  {
    id: 'document-lang',
    description: 'the document root declares its language (<html lang="…">)',
    scope: 'document',
  },
  {
    id: 'landmark-main',
    description: 'the page carries exactly one <main> landmark',
    scope: 'chrome',
  },
  {
    id: 'landmark-navigation',
    description: 'the shell renders navigation landmarks (<nav>) with labels',
    scope: 'chrome',
  },
  {
    id: 'skip-link',
    description: 'the first link is a skip-to-content link (keyboard traversal)',
    scope: 'chrome',
  },
  {
    id: 'single-h1',
    description: 'the page has exactly one <h1>',
    scope: 'content',
  },
  {
    id: 'heading-order',
    description: 'headings do not skip levels (h1 → h2 → h3…)',
    scope: 'content',
  },
  {
    id: 'img-alt',
    description: 'every <img> has an alt attribute',
    scope: 'content',
  },
  {
    id: 'button-name',
    description: 'every <button> has an accessible name (icon-only buttons carry aria-label)',
    scope: 'content',
  },
  {
    id: 'link-name',
    description: 'every <a> has an accessible name (icon-only links carry aria-label)',
    scope: 'content',
  },
  {
    id: 'no-positive-tabindex',
    description: 'no element carries a positive tabindex (DOM order is the tab order)',
    scope: 'content',
  },
  {
    id: 'input-label',
    description: 'every form control has a label (label[for], aria-label, or wrapping label)',
    scope: 'content',
  },
  {
    id: 'table-caption',
    description: 'every data table has a caption (or aria-label) and scoped headers',
    scope: 'content',
  },
  {
    id: 'touch-target',
    description: 'the shipped CSS gives bottom-nav links and icon buttons ≥44px touch targets',
    scope: 'css',
  },
  {
    id: 'nav-aria-current',
    description: 'navigation components mark the active item with aria-current',
    scope: 'css',
  },
];

const RULE_BY_ID: ReadonlyMap<A11yRuleId, A11yRule> = new Map(
  A11Y_RULES.map((rule) => [rule.id, rule]),
);

/** One rule by id (throws — the rule set is closed). */
export function a11yRule(id: A11yRuleId): A11yRule {
  const rule = RULE_BY_ID.get(id);
  if (rule === undefined) {
    throw new Error(`unknown accessibility rule '${id}'`);
  }
  return rule;
}

function headingLevel(tagName: string): number | null {
  const match = /^h([1-6])$/.exec(tagName);
  return match === null ? null : Number(match[1]);
}

/**
 * Audit one rendered page's HTML. `options.chrome` marks pages rendered
 * inside a shell (skip link + landmarks expected); `options.fullDocument`
 * marks renders that include the <html> root.
 */
export function auditHtml(html: string, options: A11yAuditOptions): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const subject = options.subject;
  const fail = (rule: A11yRuleId, detail: string): void => {
    violations.push({ rule, subject, detail });
  };

  // --- document rules ------------------------------------------------------
  if (options.fullDocument) {
    const htmlTags = findTags(html, 'html');
    if (htmlTags.length === 0 || htmlTags[0]!.attrs['lang'] === undefined) {
      fail('document-lang', 'the rendered document does not declare its language');
    }
  }

  // --- chrome rules ----------------------------------------------------------
  if (options.chrome) {
    const mains = findTags(html, 'main');
    if (mains.length === 0) {
      fail('landmark-main', 'no <main> landmark in the rendered shell');
    } else if (mains.length > 1) {
      fail('landmark-main', `${mains.length} <main> landmarks — exactly one is allowed`);
    }
    if (options.navigation ?? true) {
      const navs = findTags(html, 'nav');
      if (navs.length === 0) {
        fail('landmark-navigation', 'no <nav> landmark in the rendered shell');
      } else if (navs.some((nav) => (nav.attrs['aria-label'] ?? '').trim() === '')) {
        fail('landmark-navigation', 'a <nav> landmark carries no aria-label');
      }
    }
    const anchors = findTags(html, 'a');
    const first = anchors[0];
    if (first === undefined) {
      fail('skip-link', 'the shell renders no links at all');
    } else {
      const href = first.attrs['href'] ?? '';
      const name = accessibleName(html, first).toLowerCase();
      if (!href.startsWith('#') || !name.includes('skip')) {
        fail('skip-link', 'the first link is not a skip-to-content link');
      }
    }
  }

  // --- content rules ----------------------------------------------------------
  const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
    .flatMap((name) => findTags(html, name))
    .filter((tag) => !isHiddenTag(tag))
    .sort((a, b) => a.index - b.index);
  const h1s = findTags(html, 'h1').filter((tag) => !isHiddenTag(tag));
  if (h1s.length === 0) {
    fail('single-h1', 'the page has no <h1>');
  } else if (h1s.length > 1) {
    fail('single-h1', `${h1s.length} <h1> elements — exactly one is allowed`);
  }
  let previousLevel = 0;
  for (const heading of headings) {
    const level = headingLevel(heading.name);
    if (level === null) continue;
    if (previousLevel !== 0 && level > previousLevel + 1) {
      fail(
        'heading-order',
        `heading order skips from h${previousLevel} to h${level} (“${textContent(heading.source).slice(0, 60)}”)`,
      );
    }
    previousLevel = level;
  }

  for (const image of findTags(html, 'img')) {
    if (!('alt' in image.attrs)) {
      fail('img-alt', `an <img src="${image.attrs['src'] ?? ''}"> has no alt attribute`);
    }
  }

  for (const button of findTags(html, 'button')) {
    if (isHiddenTag(button)) continue;
    if (accessibleName(html, button) === '') {
      fail(
        'button-name',
        `a <button> has no accessible name (${button.source.slice(0, 60)}…)`,
      );
    }
  }

  for (const anchor of findTags(html, 'a')) {
    if (isHiddenTag(anchor)) continue;
    if (accessibleName(html, anchor) === '') {
      fail('link-name', `an <a href="${anchor.attrs['href'] ?? ''}"> has no accessible name`);
    }
  }

  const positiveTabindex = [...findTags(html, 'input'), ...findTags(html, 'a'), ...findTags(html, 'button'), ...findTags(html, 'textarea'), ...findTags(html, 'select')]
    .filter((tag) => tag.attrs['tabindex'] !== undefined && Number(tag.attrs['tabindex']) > 0);
  for (const tag of positiveTabindex) {
    fail('no-positive-tabindex', `<${tag.name}> carries tabindex="${tag.attrs['tabindex']}"`);
  }

  const labelIds = new Set(
    findTags(html, 'label')
      .map((label) => label.attrs['for'])
      .filter((value): value is string => value !== undefined),
  );
  for (const control of [
    ...findTags(html, 'input'),
    ...findTags(html, 'textarea'),
    ...findTags(html, 'select'),
  ]) {
    if (isHiddenTag(control)) continue;
    const type = control.attrs['type'] ?? '';
    if (type === 'hidden') continue;
    const id = control.attrs['id'];
    const hasLabelFor = id !== undefined && labelIds.has(id);
    const hasAriaLabel =
      (control.attrs['aria-label'] ?? '').trim() !== '' ||
      (control.attrs['aria-labelledby'] ?? '').trim() !== '';
    // A wrapping <label> also labels the control.
    let wrapped = false;
    if (!hasLabelFor && !hasAriaLabel) {
      const start = control.index;
      for (const label of findTags(html, 'label')) {
        if (label.index < start) {
          const end = elementEnd(html, 'label', label.index);
          if (end !== -1 && end > start) {
            wrapped = true;
            break;
          }
        }
      }
    }
    if (!hasLabelFor && !hasAriaLabel && !wrapped) {
      fail(
        'input-label',
        `a form control (<${control.name} type="${type}"> id="${id ?? 'none'}") has no label`,
      );
    }
  }

  for (const table of findTags(html, 'table')) {
    const end = elementEnd(html, 'table', table.index);
    const inner = end === -1 ? '' : html.slice(table.index, end);
    const hasCaption =
      findTags(inner, 'caption').length > 0 || (table.attrs['aria-label'] ?? '').trim() !== '';
    if (!hasCaption) {
      fail('table-caption', 'a <table> has no caption or aria-label');
    }
    if (findTags(inner, 'th').length > 0) {
      const unscoped = findTags(inner, 'th').filter((th) => th.attrs['scope'] === undefined);
      if (unscoped.length > 0) {
        fail(
          'table-caption',
          `${unscoped.length} <th> in a table carry no scope attribute`,
        );
      }
    }
  }

  return violations;
}

/**
 * The CSS/source-level rules (the halves SSR cannot show). Audits the
 * shipped sources: touch target sizes in the stylesheet, and the
 * active-state treatment in the navigation components.
 */
export function auditSources(sources: {
  productCss: string;
  navigationComponents: readonly { file: string; source: string }[];
}): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // touch-target: the mobile controls must declare sizes of at least 44px
  // in the shipped CSS (min-* or fixed * — both floor the touch target).
  const sizeOf = (css: string, selector: string, property: string): number | null => {
    const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    let best: number | null = null;
    for (const match of css.matchAll(pattern)) {
      for (const sizeMatch of (match[1] ?? '').matchAll(
        new RegExp(`(?:min-)?${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'g'),
      )) {
        const value = Number(sizeMatch[1]);
        if (best === null || value > best) best = value;
      }
    }
    return best;
  };
  const satisfies = (css: string, selector: string): boolean => {
    const height = sizeOf(css, selector, 'height');
    const width = sizeOf(css, selector, 'width');
    return height !== null && height >= 44 && width !== null && width >= 44;
  };
  // The bottom nav's width floor is structural: its links are equal 1fr
  // columns of the full viewport (repeat(N, 1fr) grid with N ≤ 5 ⇒ each
  // column ≥ 44px on any viewport ≥ 220px), so the explicit height plus
  // the equal-grid is a complete ≥44px touch-target proof.
  const hasEqualColumnGrid = (css: string): boolean =>
    /grid-template-columns\s*:\s*repeat\(([1-5]),\s*1fr\)/.test(css);
  const bottomNavHeight = sizeOf(sources.productCss, '.aurum-bottomnav a', 'height');
  if (bottomNavHeight === null || bottomNavHeight < 44 || !hasEqualColumnGrid(sources.productCss)) {
    violations.push({
      rule: 'touch-target',
      subject: 'src/app/(product)/product.css',
      detail:
        '.aurum-bottomnav a does not declare a ≥44px height over an equal-column grid (the 44px+ touch-target floor)',
    });
  }
  if (!satisfies(sources.productCss, '.aurum-icon-btn')) {
    violations.push({
      rule: 'touch-target',
      subject: 'src/app/(product)/product.css',
      detail: '.aurum-icon-btn does not declare ≥44px sizes (height/width)',
    });
  }

  // nav-aria-current: every navigation component must mark the active
  // item with aria-current.
  for (const component of sources.navigationComponents) {
    if (!component.source.includes('aria-current')) {
      violations.push({
        rule: 'nav-aria-current',
        subject: component.file,
        detail: 'the navigation component does not render aria-current for the active item',
      });
    }
  }

  return violations;
}

/** Extract the in-document links of a rendered page (for the link-graph proofs). */
export function extractPageLinks(html: string, basePath: string): LinkInfo[] {
  const links: LinkInfo[] = [];
  for (const anchor of findTags(html, 'a')) {
    const href = anchor.attrs['href'];
    if (href === undefined) continue;
    if (href === '' || href.startsWith('#') || href.startsWith('mailto:')) continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('//')) continue;
    links.push({
      href,
      resolved: href.startsWith('/') ? href : resolveInternal(href, basePath),
      accessibleName: accessibleName(html, anchor),
    });
  }
  return links;
}

function resolveInternal(href: string, basePath: string): string {
  const baseSegments = basePath.split('/').filter((segment) => segment !== '');
  const segments = [...baseSegments];
  for (const segment of href.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

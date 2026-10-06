'use strict';

/* ==========================================================================
   Editable content: schema and factory defaults.

   This file is the single definition of what the office can edit. It drives
   three things:
     1. what `scripts/seed.js` writes into the database on a fresh install,
     2. the form the admin renders at /admin/content,
     3. the fallback value the public pages use if a row is missing.

   Because the default lives beside the field, a half-populated database still
   renders a complete site rather than blank headings.

   Adding a field here makes it editable; no other file needs to change unless
   the markup for it does too.
   ========================================================================== */

/* ── Site-wide values ───────────────────────────────────────────────────── */

const SETTINGS = [
  { key: 'brand_name',    label: 'Brand name',        value: 'HERITAGE' },
  { key: 'brand_sub',     label: 'Brand subtitle',    value: 'HOUSING PROJECTS' },
  { key: 'company_legal', label: 'Registered name',   value: 'Heritage Housing Projects (Pvt) Ltd' },
  { key: 'tagline',       label: 'Tagline',           value: 'Building communities. Creating opportunities.' },

  /* Used for the canonical and social URLs. Must be the real deployed address,
     including https:// and without a trailing slash; if the site lives in a
     subfolder, include that too (https://example.com/heritage). */
  { key: 'site_url', label: 'Site address (canonical links)', value: 'https://heritagehousing.co.zw' },

  { key: 'phone',         label: 'Phone (displayed)', value: '+263 542 22697' },
  { key: 'phone_link',    label: 'Phone (dial link)', value: '+26354222697' },
  { key: 'email',         label: 'Email',             value: 'heritagehousingp@gmail.com' },
  { key: 'whatsapp_url',  label: 'WhatsApp link',     value: 'https://wa.me/message/3NT2K5FBKFQI1' },
  { key: 'office',        label: 'Office address',    value: 'NetOne Building, Office PD30, First Floor, opposite CBZ Bank, Gweru, Zimbabwe' },
  { key: 'office_short',  label: 'Office (short)',    value: 'NetOne Building, Office PD30, Gweru, Zimbabwe' },

  { key: 'footer_note',   label: 'Footer note',       value: 'Building communities. Creating opportunities.' },
  { key: 'enquiry_subject', label: 'Enquiry email subject', value: 'Website enquiry' },

  /* Logo paths. Normally set by uploading in the admin, but editable here so a
     hosted URL can be used instead. */
  { key: 'logo_url',       label: 'Logo (light backgrounds)', value: '/assets/img/logo.png' },
  { key: 'logo_light_url', label: 'Logo (dark backgrounds)',  value: '/assets/img/logo-light.png' },
  { key: 'favicon_url',    label: 'Favicon / square mark',    value: '/assets/img/logo-mark.png' },

  /* Used when a client has no stand yet, so there is no project to take
     initials from. */
  { key: 'payment_ref_prefix', label: 'Payment reference prefix (client with no stand)', value: 'HHP' }
];

/* ── Pages ──────────────────────────────────────────────────────────────────
   `meta` is the <title> and meta description.
   A section marked `repeat: true` renders one item per row and can be added
   to or removed in the admin; `items` provides the factory rows.
   ------------------------------------------------------------------------ */

const PAGES = [
  {
    key: 'home',
    label: 'Home',
    file: 'index.html',
    meta: {
      title: 'Heritage Housing Projects | Building Communities. Creating Opportunities.',
      description: 'Heritage Housing Projects (Pvt) Ltd is a Zimbabwean property developer delivering residential, commercial and mixed-use developments, infrastructure and client support.'
    },
    sections: [
      {
        key: 'hero', label: 'Hero', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'PROPERTY DEVELOPMENT • ZIMBABWE' },
          { key: 'heading', label: 'Heading line 1', type: 'text', value: 'Building Communities.' },
          { key: 'heading_accent', label: 'Heading line 2 (highlighted)', type: 'text', value: 'Creating Opportunities.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'We develop residential, commercial and mixed-use property opportunities designed to create lasting value for families, investors and communities.' },
          { key: 'cta1_label', label: 'Primary button label', type: 'text', value: 'Explore Projects' },
          { key: 'cta2_label', label: 'Secondary button label', type: 'text', value: 'Available Properties' }
        ]
      },
      {
        key: 'trust', label: 'Trust strip', repeat: true,
        fields: [
          { key: 'strong', label: 'Title', type: 'text' },
          { key: 'span', label: 'Subtitle', type: 'text' }
        ],
        items: [
          { strong: 'Land Development', span: 'From raw land to communities' },
          { strong: 'Property Sales', span: 'Residential & commercial opportunities' },
          { strong: 'Infrastructure', span: 'Roads, water, sewer & site works' },
          { strong: 'Client Portal', span: 'Track your property & payments' }
        ]
      },
      {
        key: 'whatwedo', label: '"What we do" heading', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'WHAT WE DO' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Property development with purpose.' },
          { key: 'link_label', label: 'Link label', type: 'text', value: 'About Heritage →' }
        ]
      },
      {
        key: 'feature', label: 'What we do cards', repeat: true,
        fields: [
          { key: 'icon', label: 'Icon', type: 'text' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'body', label: 'Body', type: 'textarea' }
        ],
        items: [
          { icon: '⌂', title: 'Land & Property Development', body: 'Residential, commercial and other development opportunities across Zimbabwe.' },
          { icon: '▦', title: 'Infrastructure Development', body: 'Site preparation, roads, water, sewer and related development works.' },
          { icon: '◆', title: 'Property Sales', body: 'Structured opportunities for buyers looking to secure land and property.' },
          { icon: '⚙', title: 'Construction & Works', body: 'Building, earthworks, renovations and project support.' }
        ]
      },
      {
        key: 'featured', label: 'Featured development', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'FEATURED DEVELOPMENT' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Heritage Park — Gweru' },
          { key: 'lead', label: 'Lead paragraph', type: 'textarea', value: 'Residential stands in a developing community, with servicing and infrastructure progressing toward build readiness.' },
          { key: 'cta_label', label: 'Button label', type: 'text', value: 'View Project' },
          /* The photograph for this block. Previously it was taken from the
             featured development's own record, which meant the image shipped
             for this slot could never appear while that development had one. */
          { key: 'image', label: 'Photograph (path under /images/)', type: 'text', value: '/images/featured-development.jpg' },
          { key: 'image_label', label: 'Image caption', type: 'text', value: 'HERITAGE PARK' },
          { key: 'status', label: 'Status', type: 'text', value: 'DEVELOPMENT IN PROGRESS' },
          { key: 'title', label: 'Card title', type: 'text', value: '200m² Residential Stands' },
          { key: 'body', label: 'Card body', type: 'textarea', value: 'Explore stand availability, pricing, development updates and client support through the Heritage platform.' },
          { key: 'stat1_label', label: 'Stat 1 label', type: 'text', value: 'Location' },
          { key: 'stat1_value', label: 'Stat 1 value', type: 'text', value: 'Gweru, Zimbabwe' },
          { key: 'stat2_label', label: 'Stat 2 label', type: 'text', value: 'Property' },
          { key: 'stat2_value', label: 'Stat 2 value', type: 'text', value: 'Residential' },
          { key: 'stat3_label', label: 'Stat 3 label', type: 'text', value: 'Typical size' },
          { key: 'stat3_value', label: 'Stat 3 value', type: 'text', value: '200m²' },
          { key: 'stat4_label', label: 'Stat 4 label', type: 'text', value: 'Client access' },
          { key: 'stat4_value', label: 'Stat 4 value', type: 'text', value: 'Portal enabled' },
          { key: 'stands_label', label: 'Stands button label', type: 'text', value: 'View Available Stands' }
        ]
      },
      {
        key: 'callout', label: 'Client portal callout', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'MY HERITAGE' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Everything about your property, in one place.' },
          { key: 'body', label: 'Body', type: 'textarea', value: 'Clients can view their stand details, payment history, outstanding balance, documents, project progress and support requests from a secure client area.' },
          { key: 'cta_label', label: 'Button label', type: 'text', value: 'Open Client Portal' }
        ]
      }
    ]
  },

  {
    key: 'about',
    label: 'About',
    file: 'about.html',
    meta: {
      title: 'About Us | Heritage Housing Projects',
      description: 'Heritage Housing Projects (Pvt) Ltd is a Zimbabwean property development company focused on land development, infrastructure and project delivery.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'ABOUT HERITAGE' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Developing places people can call home.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Heritage Housing Projects (Pvt) Ltd is a Zimbabwean property development company focused on land development, residential and commercial property opportunities, infrastructure and project delivery.' }
        ]
      },
      {
        key: 'who', label: 'Who we are', repeat: false,
        fields: [
          { key: 'heading', label: 'Heading', type: 'text', value: 'Who we are' },
          { key: 'body1', label: 'Paragraph 1', type: 'textarea', value: 'Our approach combines property development, project coordination and client service to turn development opportunities into communities with practical long-term value.' },
          { key: 'body2', label: 'Paragraph 2', type: 'textarea', value: 'We aim to communicate clearly with clients throughout the property journey — from enquiry and purchase through payments, documentation, development progress and build readiness.' }
        ]
      },
      {
        key: 'mission', label: 'Mission card', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Label', type: 'text', value: 'OUR MISSION' },
          { key: 'body', label: 'Mission statement', type: 'textarea', value: 'To develop quality land and property projects while delivering value, transparency and long-term opportunities to our clients and development partners.' }
        ]
      },
      {
        key: 'value', label: 'Values', repeat: true,
        fields: [
          { key: 'number', label: 'Number', type: 'text' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'body', label: 'Body', type: 'textarea' }
        ],
        items: [
          { number: '01', title: 'Integrity', body: 'Clear information, responsible processes and professional conduct.' },
          { number: '02', title: 'Development', body: 'Practical infrastructure and sustainable community development.' },
          { number: '03', title: 'Client Focus', body: 'Better communication before, during and after a property purchase.' },
          { number: '04', title: 'Value Creation', body: 'Property opportunities designed around long-term usefulness and value.' }
        ]
      },
      {
        key: 'ceo', label: 'Chief Executive', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Label', type: 'text', value: 'MEET OUR CEO' },
          { key: 'image', label: 'Photograph (path under /images/)', type: 'text', value: '/images/ceo-trish-makaka.jpg' },
          { key: 'message', label: 'Message', type: 'textarea', value: 'We are building more than stands and roads. Every project we complete becomes a place where a family puts down roots, and that responsibility guides every decision we make.' },
          { key: 'name', label: 'Name', type: 'text', value: 'Mrs. Trish B Makaka' },
          { key: 'role', label: 'Role', type: 'text', value: 'Chief Executive Officer' }
        ]
      }
    ]
  },

  {
    key: 'services',
    label: 'Services',
    file: 'services.html',
    meta: {
      title: 'Services | Heritage Housing Projects',
      description: 'Land and property development, civil and infrastructure works, construction and property services across Zimbabwe.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'OUR SERVICES' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'From land to opportunity.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Our services cover the development and delivery work required to create property opportunities and support clients through the process.' }
        ]
      },
      {
        key: 'service', label: 'Service cards', repeat: true,
        fields: [
          { key: 'icon', label: 'Icon', type: 'text' },
          { key: 'title', label: 'Title', type: 'text' },
          /* A path, not an upload. The office drops the file into /images/
             themselves and types the path here — no upload system, no base64. */
          { key: 'image', label: 'Photograph (path under /images/)', type: 'text' },
          { key: 'bullets', label: 'Bullet points (one per line)', type: 'lines' }
        ],
        items: [
          { icon: '⌂', title: 'Land & Property Development', image: '/images/service-land-property-development.jpg', bullets: 'Residential developments\nCommercial developments\nIndustrial opportunities\nLand subdivision & servicing\nCommunity development' },
          { icon: '▦', title: 'Civil & Infrastructure Works', image: '/images/service-civil-infrastructure-works.jpg', bullets: 'Site preparation\nEarthworks & grading\nRoad development\nWater & sewer infrastructure\nDrainage and related works' },
          { icon: '⚒', title: 'Construction & Property', image: '/images/service-construction-property.jpg', bullets: 'Residential buildings\nCommercial buildings\nRenovations\nBuilding maintenance\nProperty sales support' }
        ]
      }
    ]
  },

  {
    key: 'projects',
    label: 'Projects',
    file: 'projects.html',
    meta: {
      title: 'Projects | Heritage Housing Projects',
      description: 'Selected residential and commercial developments across Zimbabwe, from land development to build readiness.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'OUR PROJECTS' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Developments across Zimbabwe.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Explore selected developments and follow project progress from land development to build readiness.' }
        ]
      }
    ]
  },

  {
    key: 'properties',
    label: 'Properties',
    file: 'properties.html',
    meta: {
      title: 'Available Properties | Heritage Housing Projects',
      description: 'Browse available residential stands and property opportunities by project, type and size.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'AVAILABLE PROPERTIES' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'Find your next property opportunity.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Filter available stands and property opportunities by project, type and size.' }
        ]
      }
    ]
  },

  {
    key: 'news',
    label: 'News',
    file: 'news.html',
    meta: {
      title: 'News & Updates | Heritage Housing Projects',
      description: 'Project announcements, development updates and company news from Heritage Housing Projects.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'NEWS & UPDATES' },
          { key: 'heading', label: 'Heading', type: 'text', value: 'What is happening at Heritage.' },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Project announcements, development updates and company news.' }
        ]
      },
      {
        key: 'item', label: 'News items', repeat: true,
        fields: [
          { key: 'tag', label: 'Tag', type: 'text' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'body', label: 'Body', type: 'textarea' },
          { key: 'link_label', label: 'Link label', type: 'text' },
          { key: 'link_href', label: 'Link target', type: 'text' }
        ],
        items: [
          { tag: 'PROJECT UPDATE', title: 'Heritage Park development progress', body: 'Follow servicing, infrastructure and project milestones through the website and client portal.', link_label: 'View the project →', link_href: 'projects.html' },
          { tag: 'CLIENT SERVICES', title: 'Introducing My Heritage', body: 'Clients can access their property information, balances, payments and documents online.', link_label: 'Open portal →', link_href: 'portal.html' },
          { tag: 'COMPANY', title: 'Building stronger communities', body: 'Our focus remains on creating practical property opportunities with better client communication.', link_label: 'Read more →', link_href: 'about.html' }
        ]
      }
    ]
  },

  {
    key: 'contact',
    label: 'Contact',
    file: 'contact.html',
    meta: {
      title: 'Contact Us | Heritage Housing Projects',
      description: 'Talk to the Heritage team about a property, project, partnership or site visit. Gweru, Zimbabwe.'
    },
    sections: [
      {
        key: 'hero', label: 'Page header', repeat: false,
        fields: [
          { key: 'eyebrow', label: 'Eyebrow', type: 'text', value: 'CONTACT US' },
          { key: 'heading', label: 'Heading', type: 'text', value: "Let's discuss your property opportunity." },
          { key: 'body', label: 'Intro paragraph', type: 'textarea', value: 'Talk to the Heritage team about a property, project, partnership or site visit.' }
        ]
      },
      {
        key: 'card', label: 'Contact card', repeat: false,
        fields: [
          { key: 'heading', label: 'Heading', type: 'text', value: 'Heritage Housing Projects (Pvt) Ltd' },
          { key: 'form_heading', label: 'Form heading', type: 'text', value: 'Send an enquiry' },
          { key: 'interest_options', label: 'Enquiry types (one per line)', type: 'lines', value: 'Property\nProject\nSite visit\nPartnership\nGeneral enquiry' }
        ]
      }
    ]
  }
];

/* ── Helpers ────────────────────────────────────────────────────────────── */

const PAGE_KEYS = PAGES.map((p) => p.key);

function page(key) {
  return PAGES.find((p) => p.key === key) || null;
}

/** Settings as a plain { key: value } map of the factory defaults. */
function defaultSettings() {
  const out = Object.create(null);
  for (const s of SETTINGS) out[s.key] = s.value;
  return out;
}

/** Every block row a fresh install should contain, flattened. */
function defaultBlocks() {
  const rows = [];
  for (const p of PAGES) {
    for (const section of p.sections) {
      if (section.repeat) {
        (section.items || []).forEach((item, index) => {
          for (const field of section.fields) {
            rows.push({
              page: p.key,
              section: section.key,
              item: index + 1,
              field: field.key,
              value: item[field.key] != null ? String(item[field.key]) : ''
            });
          }
        });
      } else {
        for (const field of section.fields) {
          rows.push({
            page: p.key,
            section: section.key,
            item: 0,
            field: field.key,
            value: field.value != null ? String(field.value) : ''
          });
        }
      }
    }
  }
  return rows;
}

/** The factory value for one field, used when a database row is missing. */
function defaultValue(pageKey, sectionKey, fieldKey, item) {
  const p = page(pageKey);
  if (!p) return '';
  const section = p.sections.find((s) => s.key === sectionKey);
  if (!section) return '';
  const field = section.fields.find((f) => f.key === fieldKey);
  if (!field) return '';

  if (section.repeat) {
    const row = (section.items || [])[item - 1];
    if (!row) return '';
    return row[fieldKey] != null ? String(row[fieldKey]) : '';
  }
  return field.value != null ? String(field.value) : '';
}

/** How many factory items a repeating section starts with. */
function defaultItemCount(pageKey, sectionKey) {
  const p = page(pageKey);
  if (!p) return 0;
  const section = p.sections.find((s) => s.key === sectionKey);
  return section && section.repeat ? (section.items || []).length : 0;
}

/** True when a section key belongs to a page and repeats. */
function sectionSchema(pageKey, sectionKey) {
  const p = page(pageKey);
  if (!p) return null;
  return p.sections.find((s) => s.key === sectionKey) || null;
}

module.exports = {
  SETTINGS,
  PAGES,
  PAGE_KEYS,
  page,
  defaultSettings,
  defaultBlocks,
  defaultValue,
  defaultItemCount,
  sectionSchema
};

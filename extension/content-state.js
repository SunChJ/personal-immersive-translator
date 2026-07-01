// Global PIT_STATE, selector constants, and per-site scraping rules.
const PIT_STATE = {
  running: false,
  cancelRequested: false,
  dynamicObserver: null,
  dynamicRoots: [],
  dynamicTimer: null,
  dynamicRouteUrl: location.href,
  routeSettlingTimers: [],
  routeEventHandler: null,
  routeTranslationTimer: null,
  routeUpdatePending: false,
  floating: null,
  floatingStatusTimer: null,
  selectionTooltip: null,
  selectionTimer: null,
  selectionRequestId: 0,
  selectionTranslationEnabled: true,
  lazyObserver: null,
  lazyQueue: [],
  lazyQueuedIds: new Set(),
  lazyTimer: null,
  translated: false,
  autoTranslateActive: false,
  nextBlockId: 1,
  lastModel: "",
  sessionId: createShortId()
};

const PIT_MIN_BATCH_CHAR_LIMIT = 1800;
const PIT_MAX_BATCH_CHAR_LIMIT = 18000;
const PIT_TARGET_LANGUAGES = [
  "Chinese (Simplified)",
  "Chinese (Traditional)",
  "English",
  "Japanese",
  "Korean",
  "French",
  "German",
  "Spanish",
  "Portuguese",
  "Italian",
  "Russian",
  "Arabic",
  "Hindi",
  "Vietnamese",
  "Thai",
  "Indonesian"
];
const PIT_TARGET_LANGUAGE_LABELS = {
  "Chinese (Simplified)": "中文 (简体)",
  "Chinese (Traditional)": "中文 (繁体)",
  "English": "English",
  "Japanese": "日本語",
  "Korean": "한국어",
  "French": "Français",
  "German": "Deutsch",
  "Spanish": "Español",
  "Portuguese": "Português",
  "Italian": "Italiano",
  "Russian": "Русский",
  "Arabic": "العربية",
  "Hindi": "हिन्दी",
  "Vietnamese": "Tiếng Việt",
  "Thai": "ไทย",
  "Indonesian": "Indonesia"
};
const PIT_LAZY_ROOT_MARGIN = 600;
const PIT_DYNAMIC_SKIP_OPTIONS = {
  allowTranslatedAncestors: true,
  allowDeferredAncestors: true,
  allowInteractiveAncestors: false
};

const PIT_DIRECT_TEXT_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "figcaption",
  "caption",
  "dt",
  "dd",
  "summary",
  "td",
  "th"
].join(",");

const PIT_FORCE_TEXT_SELECTOR = [
  "[data-testid='tweetText']",
  "[role='heading']",
  "[dir='auto']",
  "[lang][dir]"
].join(",");

const PIT_INTERACTIVE_ANCESTOR_SELECTOR = [
  "button",
  "select",
  "textarea",
  "[role='button']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']"
].join(",");

const PIT_SKIP_TAGS = new Set([
  "area",
  "audio",
  "button",
  "canvas",
  "code",
  "datalist",
  "embed",
  "head",
  "hr",
  "iframe",
  "img",
  "input",
  "kbd",
  "link",
  "map",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "picture",
  "pre",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "time",
  "track",
  "video"
]);

const PIT_BLOCK_DISPLAYS = new Set([
  "block",
  "flow-root",
  "flex",
  "grid",
  "list-item",
  "table",
  "table-caption",
  "table-cell"
]);

const PIT_INLINE_DISPLAYS = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "contents"
]);

const PIT_SITE_RULES = [
  {
    host: /(^|\.)news\.ycombinator\.com$/i,
    selectors: [
      ".titleline",
      ".toptext",
      ".commtext"
    ],
    skipSelectors: [".rank", ".votelinks", ".age", ".score", ".subtext", ".pagetop", ".yclinks"]
  },
  {
    host: /(^|\.)x\.com$|(^|\.)twitter\.com$/i,
    selectors: [
      "article [data-testid='tweetText']",
      "article [lang][dir='auto']",
      "article [role='heading']",
      "main [data-testid='tweetText']"
    ],
    skipSelectors: [
      "[aria-label*='keyboard' i]",
      "[data-testid='sidebarColumn']",
      "[role='navigation']",
      "[role='search']"
    ]
  },
  {
    host: /(^|\.)github\.com$/i,
    selectors: [
      ".markdown-body h1",
      ".markdown-body h2",
      ".markdown-body h3",
      ".markdown-body p",
      ".markdown-body li",
      ".markdown-body blockquote",
      ".comment-body p",
      ".comment-body li"
    ],
    skipSelectors: ["pre", "code", ".blob-wrapper", ".highlight"]
  },
  {
    host: /(^|\.)reddit\.com$/i,
    selectors: [
      "shreddit-post [slot='text-body']",
      "shreddit-comment [slot='comment']",
      "[data-testid='post-container'] h1",
      "[data-testid='post-container'] p"
    ],
    skipSelectors: ["nav", "header", "footer", "[aria-label*='advertise' i]"]
  }
];


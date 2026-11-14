import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  onAuthStateChanged, signOut as firebaseSignOut
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';

'use strict';

/* Sacred Pages — browser-only JavaScript and Firebase Authentication. No Node.js or PHP. */
const API = 'https://api.getbible.net/v2';
const SEARCH_API = 'https://search.getbible.net/v3';
const PAGE_SIZE = 50;
const TRANSLATIONS = [
  { id: 'kjv', name: 'English — King James Version (KJV)', language: 'English', guest: true },
  { id: 'web', name: 'English — World English Bible (WEB)', language: 'English', guest: true },
  { id: 'asv', name: 'English — American Standard Version (ASV)', language: 'English', guest: true },
  { id: 'tagalog', name: 'Filipino / Tagalog — Ang Dating Biblia (1905)', language: 'Tagalog', guest: false },
  { id: 'rv1909', name: 'Español — Reina-Valera 1909', language: 'Spanish', guest: false },
  { id: 'luther1912', name: 'Deutsch — Lutherbibel 1912', language: 'German', guest: false },
  { id: 'cuv', name: '中文 — Chinese Union Version', language: 'Chinese', guest: false }
];
const DAILY = [
  { book: 20, chapter: 3, verse: 5 },   // Proverbs
  { book: 19, chapter: 23, verse: 1 },  // Psalms
  { book: 43, chapter: 3, verse: 16 },  // John
  { book: 50, chapter: 4, verse: 13 },  // Philippians
  { book: 19, chapter: 119, verse: 105 },
  { book: 45, chapter: 8, verse: 28 },  // Romans
  { book: 6, chapter: 1, verse: 9 }    // Joshua
];
const $ = id => document.getElementById(id);
const state = {
  signedIn: false, user: null, translation: 'kjv', testament: 'all',
  reader: null, readRequest: 0, search: null, searchRequest: 0,
  loadingSearch: false, loadAll: false, dailyRef: null,
  chapterCache: new Map(), dailyRequest: 0, translationCatalogueLoaded: false
};

// Format user-provided or API-provided text only with textContent, never raw HTML.
function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function show(element, visible) { element.hidden = !visible; }
function errorText(element, message) { element.textContent = message; show(element, !!message); }
function formatNumber(number) { return Number(number || 0).toLocaleString('en-US'); }
function setHash(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function translationInfo() { return TRANSLATIONS.find(t => t.id === state.translation) || TRANSLATIONS[0]; }
function getBook(bookNumber) { return BOOKS[Number(bookNumber) - 1]; }
function labelTestament(book) { return book?.testament === 'old' ? 'Old Testament' : 'New Testament'; }
function canonicalName(bookNumber) { return getBook(bookNumber)?.name || `Book ${bookNumber}`; }
function allowedTranslation(id) { return TRANSLATIONS.some(t => t.id === id && (state.signedIn || t.guest)); }

function populateTranslations() {
  const dropdown = $('translation-select');
  dropdown.replaceChildren();
  for (const t of TRANSLATIONS) {
    const option = create('option', null, t.name);
    option.value = t.id;
    option.disabled = !state.signedIn && !t.guest;
    dropdown.append(option);
  }
  if (!allowedTranslation(state.translation)) state.translation = 'kjv';
  dropdown.value = state.translation;
  show($('language-lock'), !state.signedIn);
  $('account-badge').textContent = state.signedIn
    ? `${state.user?.name || 'Signed in'} · Languages unlocked`
    : 'Guest · English';
  $('account-button').textContent = state.signedIn ? 'Sign out' : 'Sign in';
}

function renderBooks() {
  const searchText = $('book-filter').value.trim().toLowerCase();
  const filtered = BOOKS.map((book, i) => ({...book, number: i + 1}))
    .filter(book => (state.testament === 'all' || book.testament === state.testament)
      && book.name.toLowerCase().includes(searchText));
  $('books-count').textContent = `${filtered.length} book${filtered.length === 1 ? '' : 's'} shown`;
  const grid = $('book-grid');
  grid.replaceChildren();
  for (const book of filtered) {
    const card = create('article', 'book-card');
    const top = create('div', 'book-card-top');
    top.append(create('span', 'book-number', String(book.number).padStart(2, '0')),
      create('span', 'book-arrow', '↗'));
    card.append(top, create('h4', null, book.name), create('p', null, labelTestament(book)));
    const bottom = create('div', 'book-card-bottom');
    const button = create('button', 'book-link', 'Browse chapters →');
    button.type = 'button';
    button.addEventListener('click', () => openChapter(book.number, 1));
    bottom.append(create('span', null, `${book.chapters} chapters`), button);
    card.append(bottom);
    grid.append(card);
  }
  if (!filtered.length) grid.append(create('p', 'empty-message', 'No Bible books matched your search.'));
}

// A normal reference can be entered into the same box as a word search.
// Examples: John 3, John 3:16, John 3:16-18, 1 John 4:7, Psalm 23.
function parseReference(query) {
  const match = query.trim().match(/^(.+?)\s+(\d{1,3})(?::(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?)?$/u);
  if (!match) return null;
  const inputBook = match[1].trim().toLowerCase().replace(/\.$/, '');
  const aliases = {
    'psalm': 'psalms', 'ps': 'psalms', 'psa': 'psalms',
    'song of songs': 'song of solomon', 'song': 'song of solomon',
    'jn': 'john', 'jhn': 'john', 'gen': 'genesis', 'ex': 'exodus',
    'prov': 'proverbs', 'rev': 'revelation', 'matt': 'matthew',
    'phil': 'philippians', 'rom': 'romans', 'cor': '1 corinthians'
  };
  const normalized = aliases[inputBook] || inputBook;
  const idx = BOOKS.findIndex(book => book.name.toLowerCase() === normalized);
  if (idx === -1) return null;
  const chapter = Number(match[2]);
  if (chapter < 1 || chapter > BOOKS[idx].chapters) {
    return { invalid: `Chapter ${chapter} does not exist in ${BOOKS[idx].name}. It has ${BOOKS[idx].chapters} chapters.` };
  }
  const verse = match[3] ? Number(match[3]) : null;
  const end = match[4] ? Number(match[4]) : verse;
  if ((verse !== null && verse < 1) || (end !== null && end < verse)) {
    return { invalid: 'Please enter a valid verse number or verse range.' };
  }
  return { book: idx + 1, chapter, verse, end };
}

function renderHighlightedText(parent, text, query) {
  const words = String(query || '').trim().split(/\s+/u).filter(Boolean);
  if (!words.length) { parent.textContent = text; return; }
  // Word boundaries avoid highlighting "love" inside "loved" or "beloved".
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  let rx;
  try { rx = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'); }
  catch { parent.textContent = text; return; }
  let last = 0;
  for (const match of String(text).matchAll(rx)) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    parent.append(create('mark', null, match[0]));
    last = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(last)));
}

function clearResults() {
  ++state.searchRequest;
  state.search = null;
  state.loadingSearch = false;
  state.loadAll = false;
  $('results-list').replaceChildren();
  show($('results'), false);
  errorText($('results-error'), '');
}

async function executeSearch() {
  const input = $('scripture-input').value.trim();
  if (!input) return;
  const reference = parseReference(input);
  if (reference?.invalid) {
    clearResults();
    show($('results'), true);
    $('results-title').textContent = 'Invalid reference';
    $('results-subtitle').textContent = '';
    $('results-count').textContent = '';
    $('results-list').replaceChildren();
    errorText($('results-error'), reference.invalid);
    show($('load-more'), false); show($('load-all'), false);
    setHash('results');
    return;
  }
  if (reference) {
    clearResults();
    await openChapter(reference.book, reference.chapter, reference.verse, reference.end);
    return;
  }
  clearResults();
  const seq = state.searchRequest;
  state.search = { query: input, translation: state.translation,
    scope: $('scope-select').value, offset: 0, total: 0, displayed: 0, hasMore: false, seq };
  $('results-title').textContent = `Verses containing “${input}”`;
  $('results-eyebrow').textContent = 'FULL BIBLE WORD SEARCH';
  $('results-subtitle').textContent = 'Looking through Scripture…';
  $('results-count').textContent = 'Searching…';
  $('results-progress').textContent = '';
  $('results-list').replaceChildren();
  show($('results'), true);
  show($('load-more'), false); show($('load-all'), false);
  errorText($('results-error'), '');
  setHash('results');
  await fetchSearchPage(seq);
}

async function fetchSearchPage(seq) {
  const search = state.search;
  if (!search || search.seq !== seq || state.loadingSearch || !search.translation) return;
  state.loadingSearch = true;
  $('load-more').disabled = true;
  $('load-all').disabled = true;
  try {
    const url = new URL(`${SEARCH_API}/${encodeURIComponent(search.translation)}`);
    url.search = new URLSearchParams({
      q: search.query, words: search.query.includes(' ') ? 'phrase' : 'all',
      match: 'whole_word', scope: search.scope,
      sort: 'canonical', limit: String(PAGE_SIZE), offset: String(search.offset)
    }).toString();
    const response = await fetch(url.toString());
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || `Search service returned HTTP ${response.status}.`);
    if (!state.search || state.search.seq !== seq) return;
    if (data.query?.kind !== 'search' || !Array.isArray(data.matches)) {
      throw new Error('The search service returned an unexpected response.');
    }
    search.total = Number(data.query.total || 0);
    search.hasMore = Boolean(data.query.has_more);
    const items = data.matches;
    for (const match of items) {
      const key = `${search.translation}_${match.book_nr}_${match.chapter}`;
      const chapter = data.results?.[key] || Object.values(data.results || {}).find(v =>
        Number(v.book_nr) === Number(match.book_nr) && Number(v.chapter) === Number(match.chapter));
      const verse = chapter?.verses?.find(v => Number(v.verse) === Number(match.verse));
      if (verse) appendResult(match, chapter, verse, search.query);
    }
    search.offset += items.length;
    search.displayed += items.length;
    $('results-count').textContent = `${formatNumber(search.total)} matching verse${search.total === 1 ? '' : 's'}`;
    $('results-subtitle').textContent = search.total
      ? `The word or phrase appears in ${formatNumber(search.total)} verses in ${translationInfo().name.split(' — ').pop()}. Every result shows its book, chapter, and verse.`
      : 'No verses found. Try a different word or check your spelling.';
    $('results-progress').textContent = `${formatNumber(search.displayed)} of ${formatNumber(search.total)} matching verses shown`;
    // The API limits result offsets to 10,000 for a single query.
    const canContinue = search.hasMore && search.offset < 10000 && items.length > 0;
    show($('load-more'), canContinue);
    show($('load-all'), canContinue && search.total <= 10000 && !state.loadAll);
    if (search.total > 10000) {
      $('results-progress').textContent += ' · API limits results to the first 10,000 per query; narrow the testament to see more.';
    }
  } catch (error) {
    if (state.search?.seq === seq) {
      errorText($('results-error'), `${error.message} Check your internet connection or try again later.`);
      $('results-count').textContent ||= 'Search unavailable';
      if (state.search.displayed > 0) show($('load-more'), true);
    }
  } finally {
    state.loadingSearch = false;
    $('load-more').disabled = false;
    $('load-all').disabled = false;
  }
}

function appendResult(match, chapter, verse, term) {
  const card = create('article', 'search-result');
  const meta = create('div', 'result-meta');
  const bookName = chapter?.book_name || canonicalName(match.book_nr);
  const book = getBook(match.book_nr);
  meta.append(create('span', 'result-book', bookName),
    create('span', 'result-testament', labelTestament(book)),
    create('span', 'result-reference', `${bookName} ${match.chapter}:${match.verse}`));
  card.append(meta);
  const paragraph = create('p', 'result-verse');
  renderHighlightedText(paragraph, String(verse.text || '').trim(), term);
  card.append(paragraph);
  const action = create('button', 'text-link', 'Read in context →');
  action.type = 'button';
  action.addEventListener('click', () => openChapter(Number(match.book_nr), Number(match.chapter), Number(match.verse)));
  card.append(action);
  $('results-list').append(card);
}

async function loadAllResults() {
  if (state.loadAll || !state.search) return;
  state.loadAll = true;
  const seq = state.search.seq;
  show($('load-all'), false);
  // Pull all pages sequentially rather than overloading the public API.
  while (state.search?.seq === seq && state.search.hasMore && state.search.offset < 10000) {
    const before = state.search.offset;
    await fetchSearchPage(seq);
    if (!state.search || state.search.seq !== seq || before === state.search.offset) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  state.loadAll = false;
  if (state.search?.seq === seq) show($('load-all'),
    state.search.hasMore && state.search.offset < 10000 && state.search.total <= 10000);
}

function buildChapterPicker(book, chapter) {
  const grid = $('chapter-grid');
  grid.replaceChildren();
  $('chapters-heading').textContent = `${book.name} — ${book.chapters} chapters`;
  for (let i = 1; i <= book.chapters; ++i) {
    const button = create('button', i === chapter ? 'current' : '', i);
    button.type = 'button';
    if (i === chapter) button.setAttribute('aria-current', 'page');
    button.setAttribute('aria-label', `${book.name} chapter ${i}`);
    button.addEventListener('click', () => openChapter(BOOKS.indexOf(book) + 1, i));
    grid.append(button);
  }
}

async function openChapter(bookNumber, chapter, selectedVerse = null, endVerse = null) {
  const book = getBook(bookNumber);
  if (!book || chapter < 1 || chapter > book.chapters) return;
  const request = ++state.readRequest;
  state.reader = { book: bookNumber, chapter, selectedVerse, endVerse };
  show($('reader'), true);
  $('reader-title').textContent = `${book.name} ${chapter}`;
  $('reader-translation').textContent = translationInfo().name;
  $('reader-testament').textContent = labelTestament(book);
  $('verses-heading').textContent = `Verses in Chapter ${chapter}`;
  $('chapter-status').textContent = `Chapter ${chapter} of ${book.chapters}`;
  $('previous-chapter').disabled = chapter <= 1;
  $('next-chapter').disabled = chapter >= book.chapters;
  buildChapterPicker(book, chapter);
  $('verse-list').replaceChildren(create('p', 'loading-message', 'Loading Scripture…'));
  errorText($('reader-error'), '');
  setHash('reader');
  const cacheKey = `${state.translation}:${bookNumber}:${chapter}`;
  try {
    let data = state.chapterCache.get(cacheKey);
    if (!data) {
      const response = await fetch(`${API}/${state.translation}/${bookNumber}/${chapter}.json`);
      if (!response.ok) throw new Error(`Bible service returned HTTP ${response.status}.`);
      data = await response.json();
      if (!Array.isArray(data.verses)) throw new Error('Bible service returned an invalid chapter.');
      state.chapterCache.set(cacheKey, data);
    }
    if (request !== state.readRequest) return;
    const list = $('verse-list');
    list.replaceChildren();
    const end = endVerse ?? selectedVerse;
    for (const verse of data.verses) {
      const num = Number(verse.verse);
      const isSelected = selectedVerse !== null && num >= selectedVerse && num <= end;
      const item = create('article', `verse-item${isSelected ? ' selected-verse' : ''}`);
      item.id = `verse-${num}`;
      item.append(create('span', 'verse-number', num),
        create('p', null, String(verse.text || '').trim()));
      list.append(item);
    }
    if (!data.verses.length) list.append(create('p', 'empty-message', 'No verse text was returned for this chapter.'));
    if (selectedVerse !== null) {
      const found = data.verses.some(v => Number(v.verse) === selectedVerse);
      if (!found) errorText($('reader-error'), `Verse ${selectedVerse} was not found in this chapter.`);
      else $('verse-list').querySelector(`#verse-${selectedVerse}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } catch (error) {
    if (request !== state.readRequest) return;
    $('verse-list').replaceChildren();
    errorText($('reader-error'), `${error.message} Please check your connection and try another chapter.`);
  }
}

async function renderDailyVerse() {
  const request = ++state.dailyRequest;
  const tx = state.translation;
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 0);
  const dayNumber = Math.floor((now - yearStart) / 86400000);
  const today = DAILY[dayNumber % DAILY.length];
  state.dailyRef = today;
  $('date-label').textContent = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  $('daily-reference').textContent = `${canonicalName(today.book)} ${today.chapter}:${today.verse} · ${state.translation.toUpperCase()}`;
  try {
    const cacheKey = `${state.translation}:${today.book}:${today.chapter}`;
    let data = state.chapterCache.get(cacheKey);
    if (!data) {
      const res = await fetch(`${API}/${state.translation}/${today.book}/${today.chapter}.json`);
      if (!res.ok) throw new Error('Daily verse unavailable');
      data = await res.json();
      state.chapterCache.set(cacheKey, data);
    }
    // Ignore a stale response from an older translation request.
    if (request !== state.dailyRequest || tx !== state.translation) return;
    const verse = data.verses?.find(v => Number(v.verse) === today.verse);
    $('daily-text').textContent = verse?.text?.trim() || 'Open a chapter below to explore Scripture.';
  } catch {
    if (request === state.dailyRequest)
      $('daily-text').textContent = 'Daily verse could not load. Check your internet connection and try again.';
  }
}

async function loadAvailableTranslations() {
  if (state.translationCatalogueLoaded) return;
  try {
    const response = await fetch(`${API}/translations.json`);
    if (!response.ok) throw new Error('Translation catalogue unavailable');
    const catalogue = await response.json();
    if (!catalogue || typeof catalogue !== 'object') return;
    for (const [id, entry] of Object.entries(catalogue)) {
      if (!/^[a-z0-9]+$/.test(id) || TRANSLATIONS.some(t => t.id === id)) continue;
      const language = String(entry?.language || entry?.lang || 'Other language');
      const name = String(entry?.translation || id.toUpperCase());
      TRANSLATIONS.push({ id, name: `${language} — ${name}`, language, guest: false });
    }
    state.translationCatalogueLoaded = true;
    if (state.signedIn) populateTranslations();
  } catch {
    // The curated English, Tagalog, Spanish, German and Chinese options remain usable.
  }
}

function openSignInModal() {
  show($('signin-modal'), true);
  document.body.classList.add('modal-open');
}
function closeSignInModal() {
  show($('signin-modal'), false);
  document.body.classList.remove('modal-open');
}

// Firebase SDK verifies Google sign-in and remembers sessions across reloads.
// The English-only guest restriction is a UI feature, not secure authorization.
let firebaseAuth = null;
function firebaseIsConfigured() {
  const cfg = window.FIREBASE_CONFIG;
  return cfg && ['apiKey', 'authDomain', 'projectId', 'appId'].every(key =>
    typeof cfg[key] === 'string' && cfg[key].trim() && !/YOUR_|PASTE_|example/i.test(cfg[key]));
}
function showLoginError(message) {
  const panel = $('google-config-help');
  panel.replaceChildren(create('strong', null, 'Google sign-in'), create('span', null, message));
  show(panel, true);
}
function configureFirebaseSignIn() {
  const container = $('google-button');
  container.replaceChildren();
  if (!firebaseIsConfigured()) {
    showLoginError('Add your Firebase web app config in config.js, then run the site on an authorized localhost or HTTPS domain.');
    return;
  }
  try {
    const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
    firebaseAuth = getAuth(firebaseApp);
  } catch (error) {
    showLoginError(`Firebase could not initialize: ${error.message}`);
    return;
  }

  show($('google-config-help'), false);
  const button = create('button', 'firebase-google-button');
  button.type = 'button';
  const logo = create('span', 'google-g', 'G');
  logo.setAttribute('aria-hidden', 'true');
  button.append(logo, create('span', null, 'Continue with Google'));
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(firebaseAuth, provider);
    } catch (error) {
      if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
        let msg = `Sign-in failed: ${error.code || error.message}`;
        if (error.code === 'auth/unauthorized-domain') msg = 'This website is not an authorized Firebase Authentication domain. Add localhost or your domain under Authentication > Settings > Authorized domains.';
        if (error.code === 'auth/popup-blocked') msg = 'Your browser blocked the login window. Allow popups for this website and try again.';
        if (error.code === 'auth/operation-not-allowed') msg = 'Enable Google under Firebase Authentication > Sign-in method.';
        showLoginError(msg);
      }
    } finally {
      button.disabled = false;
    }
  });
  container.append(button);

  onAuthStateChanged(firebaseAuth, user => {
    const previousTranslation = state.translation;
    state.user = user ? { id: user.uid, name: user.displayName || user.email?.split('@')[0] || 'Google user' } : null;
    state.signedIn = Boolean(user);
    if (!user) state.translation = 'kjv';
    populateTranslations();
    if (user) {
      closeSignInModal();
      loadAvailableTranslations();
    }
    // If a signed-in user was reading another language, restore English on sign-out.
    if (!user && previousTranslation !== state.translation) {
      renderDailyVerse();
      if (state.search) {
        $('scripture-input').value = state.search.query;
        executeSearch();
      }
      if (state.reader) openChapter(state.reader.book, state.reader.chapter);
    }
  }, error => showLoginError(`Authentication error: ${error.message}`));
}
async function signOut() {
  if (!firebaseAuth) return;
  try {
    await firebaseSignOut(firebaseAuth);
  } catch (error) {
    alert(`Could not sign out: ${error.message}`);
  }
}

function attachEvents() {
  $('scripture-form').addEventListener('submit', event => { event.preventDefault(); executeSearch(); });
  document.querySelectorAll('[data-search]').forEach(button => {
    button.addEventListener('click', () => { $('scripture-input').value = button.dataset.search; executeSearch(); });
  });
  $('load-more').addEventListener('click', () => state.search && fetchSearchPage(state.search.seq));
  $('load-all').addEventListener('click', loadAllResults);
  $('book-filter').addEventListener('input', renderBooks);
  document.querySelectorAll('[data-testament]').forEach(button => {
    button.addEventListener('click', () => {
      state.testament = button.dataset.testament;
      document.querySelectorAll('[data-testament]').forEach(tab => tab.classList.toggle('active', tab === button));
      renderBooks();
    });
  });
  $('previous-chapter').addEventListener('click', () => {
    if (state.reader) openChapter(state.reader.book, state.reader.chapter - 1);
  });
  $('next-chapter').addEventListener('click', () => {
    if (state.reader) openChapter(state.reader.book, state.reader.chapter + 1);
  });
  $('translation-select').addEventListener('change', () => {
    const chosen = $('translation-select').value;
    if (!allowedTranslation(chosen)) { populateTranslations(); openSignInModal(); return; }
    state.translation = chosen;
    if (state.search) { $('scripture-input').value = state.search.query; executeSearch(); }
    if (state.reader) openChapter(state.reader.book, state.reader.chapter);
    renderDailyVerse();
  });
  $('scope-select').addEventListener('change', () => {
    if (state.search) executeSearch();
  });
  $('language-lock').addEventListener('click', openSignInModal);
  $('account-button').addEventListener('click', () => state.signedIn ? signOut() : openSignInModal());
  $('close-modal').addEventListener('click', closeSignInModal);
  $('continue-guest').addEventListener('click', closeSignInModal);
  $('signin-modal').addEventListener('click', event => {
    if (event.target === $('signin-modal')) closeSignInModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('signin-modal').hidden) closeSignInModal();
  });
  $('daily-read').addEventListener('click', () => {
    if (state.dailyRef) openChapter(state.dailyRef.book, state.dailyRef.chapter, state.dailyRef.verse);
  });
}

populateTranslations();
renderBooks();
attachEvents();
renderDailyVerse();
configureFirebaseSignIn();

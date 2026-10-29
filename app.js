/* ============================================
   QUIZLY — APPLICATION LAYER (app.js)
   Page controllers, routing, UI logic.
   ============================================ */

/* ============================================
   UTILITIES
   ============================================ */

const Utils = {
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  pct(correct, total) {
    if (!total) return 0;
    return Math.round((correct / total) * 100);
  },

  grade(pct) {
    if (pct >= 90) return 'Excellent';
    if (pct >= 75) return 'Great job';
    if (pct >= 60) return 'Good effort';
    if (pct >= 40) return 'Keep practicing';
    return 'Needs work';
  },

  // Build multiple-choice options for a card from a set
  buildOptions(cards, correctCard, field, count = 4) {
    const correct = correctCard[field];
    const pool = cards
      .filter(c => c.id !== correctCard.id)
      .map(c => c[field]);
    const distractors = Utils.shuffle(pool).slice(0, count - 1);
    return Utils.shuffle([correct, ...distractors]);
  },

  formatDuration(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  },

  // Lower-case, drop accents and punctuation, collapse spaces (works for any script)
  normalize(s) {
    return String(s ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return prev[n];
  },

  // Forgiving answer check: 'exact' | 'close' (small typo) | 'wrong'
  checkTyped(input, answer) {
    const a = Utils.normalize(input);
    const b = Utils.normalize(answer);
    if (!a) return 'wrong';
    if (a === b) return 'exact';
    const allowed = b.length <= 4 ? 0 : b.length <= 9 ? 1 : 2;
    return allowed && Utils.editDistance(a, b) <= allowed ? 'close' : 'wrong';
  },
};

/* ============================================
   RETRY QUEUE
   Used by the games: a card you miss comes back a few
   cards later, and the game only ends once every card
   has been answered correctly.
   ============================================ */

class CardQueue {
  constructor(cards) {
    this.items      = Utils.shuffle(cards);
    this.total      = cards.length;
    this.missed     = new Set();
    this.missedList = [];
  }
  get current()  { return this.items[0]; }
  get left()     { return this.items.length; }
  get done()     { return this.items.length === 0; }
  get firstTry() { return this.total - this.missed.size; }

  pass() { this.items.shift(); }

  fail() {
    const c = this.items.shift();
    if (!c) return;
    if (!this.missed.has(c.id)) { this.missed.add(c.id); this.missedList.push(c); }
    this.items.splice(Math.min(this.items.length, 3), 0, c);
  }
}

/* ---- Shared game helpers ---- */

// Returns the active set, or sends the user back to Study Sets
function _studySet(minCards = 1) {
  const setId = App.activeSetId;
  if (!setId) { App.navigate('sets'); return null; }
  const set = DB.Sets.get(setId);
  if (!set || set.cards.length === 0) { App.navigate('sets'); return null; }
  if (set.cards.length < minCards) {
    Toast.show('This game needs at least ' + minCards + ' cards in the set.', 'error', 3200);
    App.navigate('sets');
    return null;
  }
  return set;
}

// Fills <prefix>-result-{title,sub,stats,extra,actions} and shows <prefix>-result
function _renderResult(prefix, { title, sub, stats = [], extra = '', actions = [] }) {
  const $ = id => document.getElementById(prefix + '-result' + id);
  $('-title').textContent = title;
  $('-sub').textContent   = sub;
  $('-stats').innerHTML   = stats.map(s =>
    `<div class="result-stat-card ${s.cls}"><span class="result-stat-val">${_esc(s.value)}</span>${_esc(s.label)}</div>`
  ).join('');
  $('-extra').innerHTML = extra;
  const box = $('-actions');
  box.innerHTML = '';
  actions.forEach(a => {
    const b = document.createElement('button');
    b.className = a.primary ? 'btn-primary' : 'btn-outline';
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    box.appendChild(b);
  });
  document.getElementById(prefix + '-result').classList.remove('hidden');
}

function _missedList(label, cards) {
  if (!cards.length) return '';
  return `<div class="missed-box"><p class="missed-label">${_esc(label)}</p><ul class="missed-list">` +
    cards.map(c =>
      `<li><span class="missed-term">${_esc(c.term)}</span><span class="missed-def">${_esc(c.definition)}</span></li>`
    ).join('') + '</ul></div>';
}

// Progress bar + chips for the queue-based games (ids: <prefix>-progress-*, <prefix>-chip-*)
function _queueProgress(prefix, q) {
  const learned = q.total - q.left;
  document.getElementById(prefix + '-progress-fill').style.width = Utils.pct(learned, q.total) + '%';
  document.getElementById(prefix + '-progress-text').textContent = learned + ' / ' + q.total;
  document.getElementById(prefix + '-chip-ok').textContent   = learned + ' learned';
  document.getElementById(prefix + '-chip-miss').textContent = q.missed.size + ' missed';
  document.getElementById(prefix + '-chip-left').textContent = q.left + ' left';
}

// Log the session and show the end screen for a queue-based game
function _finishQueueGame(prefix, mode, setId, q, startMs, again) {
  const dur = Date.now() - startMs;
  DB.Progress.recordSession(setId, q.firstTry, q.total);
  DB.Sessions.log(setId, mode, q.firstTry, q.total, dur);
  const pct = Utils.pct(q.firstTry, q.total);
  _renderResult(prefix, {
    title: 'Every card learned',
    sub:   pct + '% right on the first try — ' + Utils.grade(pct) + ' — ' + Utils.formatDuration(dur),
    stats: [
      { value: q.firstTry,     label: 'Right first try', cls: 'correct' },
      { value: q.missed.size,  label: 'Needed a retry',  cls: q.missed.size ? 'wrong' : 'neutral' },
    ],
    extra:   _missedList('Needed a retry', q.missedList),
    actions: [
      { label: 'Play again', onClick: again },
      { label: 'Back to flashcards', primary: true, onClick: () => App.navigate('flashcards') },
    ],
  });
}

/* ============================================
   TOAST
   ============================================ */

const Toast = {
  _timer: null,
  show(msg, type = '', duration = 2400) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { el.className = 'toast hidden'; }, duration);
  },
};

/* ============================================
   MODAL
   ============================================ */

const Modal = {
  close(id) {
    document.getElementById(id).classList.add('hidden');
  },
  open(id) {
    document.getElementById(id).classList.remove('hidden');
  },
};

/* ============================================
   APP ROUTER
   ============================================ */

const App = {
  currentPage: 'home',
  // The set being studied (shared across study pages)
  activeSetId: null,

  init() {
    DB.init();
    this._bindNav();
    this.navigate('home');
    this._updateStreak();
  },

  _bindNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.navigate(btn.dataset.page);
      });
    });
  },

  navigate(page, setId) {
    // Update active set if provided
    if (setId !== undefined) this.activeSetId = setId;

    // Stop timers on the page we're leaving
    this._leave(this.currentPage);

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    // Show target page
    const pageEl = document.getElementById('page-' + page);
    if (!pageEl) return;
    pageEl.classList.add('active');

    // Highlight nav
    const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');

    this.currentPage = page;

    // Init page
    switch (page) {
      case 'home':       HomePage.init();       break;
      case 'sets':       SetsPage.init();       break;
      case 'flashcards': FlashcardPage.init();  break;
      case 'learn':      LearnPage.init();      break;
      case 'quiz':       QuizPage.init();       break;
      case 'match':      MatchPage.init();      break;
      case 'lesson':     LessonPage.init();     break;
      case 'write':      WritePage.init();      break;
      case 'speed':      SpeedPage.init();      break;
      case 'hangman':    HangmanPage.init();    break;
      case 'tf':         TFPage.init();         break;
      case 'create':     CreatePage.init();     break;
      case 'stats':      StatsPage.init();      break;
    }
  },

  _leave(page) {
    if (page === 'speed') SpeedPage.stop();
    if (page === 'match') MatchPage.stop();
    if (page === 'tf')    TFPage.stop();
    if (page === 'lesson') LessonPage.stop();
  },

  _updateStreak() {
    const meta = DB.Meta.get();
    const streak = meta.streak || 0;
    document.getElementById('streak-count').textContent = streak;
  },

  // Navigate to study mode with a specific set
  studySet(setId, mode) {
    this.activeSetId = setId;
    this.navigate(mode, setId);
  },
};

/* ============================================
   HOME PAGE
   ============================================ */

const HomePage = {
  init() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('home-greeting').textContent = greeting;

    const sets    = DB.Sets.list();
    const meta    = DB.Meta.get();
    const acc     = DB.Progress.globalAccuracy();

    document.getElementById('stat-sets').textContent    = sets.length;
    document.getElementById('stat-studied').textContent = meta.totalCardsStudied || 0;
    document.getElementById('stat-accuracy').textContent = acc !== null ? acc + '%' : '-';
    document.getElementById('stat-streak').textContent  = (meta.streak || 0) + 'd';

    const list = document.getElementById('home-set-list');
    const empty = document.getElementById('home-empty');

    if (sets.length === 0) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }

    empty.classList.add('hidden');
    list.innerHTML = '';
    sets.slice(0, 6).forEach(s => {
      list.appendChild(this._renderSetCard(s));
    });
  },

  _renderSetCard(s) {
    const mastery = DB.Progress.masteryForSet(s.id);
    const div = document.createElement('div');
    div.className = 'set-card';
    div.innerHTML = `
      <div class="set-card-body">
        <div class="set-card-title">${_esc(s.title)}</div>
        <div class="set-card-meta">
          <span class="set-subject-badge">${_esc(s.subject)}</span>
          <span>${s.cards.length} cards</span>
          ${s.description ? `<span>${_esc(s.description)}</span>` : ''}
        </div>
      </div>
      <div class="set-card-progress">
        <div class="set-card-progress-bar">
          <div class="set-card-progress-fill" style="width:${mastery}%"></div>
        </div>
        <div class="set-card-progress-label">${mastery}% mastered</div>
      </div>
      <div class="set-card-actions">
        <button class="study-btn" onclick="App.studySet('${s.id}','flashcards')">Study</button>
      </div>
    `;
    return div;
  },
};

/* ============================================
   SETS PAGE
   ============================================ */

const SetsPage = {
  _all: [],

  init() {
    this._all = DB.Sets.list();
    this._render(this._all);
  },

  filterSets(query) {
    const q = query.toLowerCase().trim();
    const filtered = q
      ? this._all.filter(s =>
          s.title.toLowerCase().includes(q) ||
          s.subject.toLowerCase().includes(q) ||
          (s.description || '').toLowerCase().includes(q)
        )
      : this._all;
    this._render(filtered);
  },

  _render(sets) {
    const list = document.getElementById('sets-list');
    list.innerHTML = '';
    if (sets.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No sets found.</p></div>';
      return;
    }
    sets.forEach(s => list.appendChild(this._card(s)));
  },

  _card(s) {
    const mastery = DB.Progress.masteryForSet(s.id);
    const acc     = DB.Progress.accuracyForSet(s.id);
    const div = document.createElement('div');
    div.className = 'set-card';
    div.innerHTML = `
      <div class="set-card-body">
        <div class="set-card-title">${_esc(s.title)}</div>
        <div class="set-card-meta">
          <span class="set-subject-badge">${_esc(s.subject)}</span>
          <span>${s.cards.length} cards</span>
          ${acc !== null ? `<span>Avg. ${acc}% accuracy</span>` : ''}
        </div>
      </div>
      <div class="set-card-progress">
        <div class="set-card-progress-bar">
          <div class="set-card-progress-fill" style="width:${mastery}%"></div>
        </div>
        <div class="set-card-progress-label">${mastery}% mastered</div>
      </div>
      <div class="set-card-actions">
        <button class="icon-btn" title="Export" onclick="ExportModal.open('${s.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="icon-btn" title="Edit" onclick="CreatePage.editSet('${s.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="icon-btn danger" title="Delete" onclick="SetsPage.confirmDelete('${s.id}','${_esc(s.title)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
        </button>
        <button class="study-btn" onclick="App.studySet('${s.id}','flashcards')">Study</button>
      </div>
    `;
    return div;
  },

  confirmDelete(id, title) {
    document.getElementById('modal-delete-body').textContent =
      `Delete "${title}"? This cannot be undone.`;
    const btn = document.getElementById('modal-delete-confirm');
    btn.onclick = () => {
      DB.Sets.delete(id);
      Modal.close('modal-delete');
      Toast.show('Set deleted.', 'error');
      this.init();
    };
    Modal.open('modal-delete');
  },
};

/* ============================================
   FLASHCARD PAGE
   Round 1 goes through every card. Cards marked
   "Still learning" come back in the next round, and
   rounds repeat until every card is marked "Got it".
   ============================================ */

const FlashcardPage = {
  _all:       [],     // every card in the set
  _cards:     [],     // the deck for the current round
  _marks:     {},     // cardId -> true (got it) / false (still learning), this round only
  _missed:    [],     // cards missed in the round that just ended
  _index:     0,
  _flipped:   false,
  _round:     1,
  _firstPass: null,
  _setId:     null,
  _startMs:   0,
  _studying:  false,

  init() {
    const setId = App.activeSetId;
    if (!setId) { App.navigate('sets'); return; }
    const set = DB.Sets.get(setId);
    if (!set || set.cards.length === 0) { App.navigate('sets'); return; }

    this._setId = setId;
    this._all   = [...set.cards];

    document.getElementById('fc-title').textContent = set.title;
    document.getElementById('fc-set-meta').textContent =
      set.subject + ' — ' + set.cards.length + ' cards';

    DB.Meta.recordStudyDay();
    this._begin();
  },

  isStudying() { return this._studying; },

  _begin() {
    this._round     = 1;
    this._cards     = [...this._all];
    this._marks     = {};
    this._missed    = [];
    this._index     = 0;
    this._firstPass = null;
    this._startMs   = Date.now();
    this._showStudy();
    this._render();
  },

  _showStudy() {
    this._studying = true;
    document.getElementById('fc-result').classList.add('hidden');
    document.getElementById('fc-study').classList.remove('hidden');
  },

  _render() {
    const card  = this._cards[this._index];
    const total = this._cards.length;
    document.getElementById('fc-term-text').textContent = card.term;
    document.getElementById('fc-def-text').textContent  = card.definition;
    document.getElementById('fc-inner').classList.remove('flipped');
    this._flipped = false;

    const verdicts = Object.values(this._marks);
    const known    = verdicts.filter(v => v === true).length;
    const learning = verdicts.filter(v => v === false).length;

    document.getElementById('fc-progress-fill').style.width = Utils.pct(verdicts.length, total) + '%';
    document.getElementById('fc-progress-text').textContent = 'Card ' + (this._index + 1) + ' of ' + total;

    const knownOverall = this._all.length - total + known;
    document.getElementById('fc-known-text').textContent =
      'Known so far: ' + knownOverall + ' / ' + this._all.length;

    const badge = document.getElementById('fc-round');
    badge.textContent = this._round === 1
      ? 'Round 1 — all ' + total + ' cards'
      : 'Round ' + this._round + ' — reviewing ' + total + ' missed ' + (total === 1 ? 'card' : 'cards');
    badge.classList.toggle('review', this._round > 1);

    document.getElementById('fc-stat-correct').textContent = known + ' got it';
    document.getElementById('fc-stat-wrong').textContent   = learning + ' still learning';
  },

  flip() {
    if (!this._studying) return;
    this._flipped = !this._flipped;
    document.getElementById('fc-inner').classList.toggle('flipped', this._flipped);
  },

  next() {
    if (this._studying && this._index < this._cards.length - 1) {
      this._index++;
      this._render();
    }
  },

  prev() {
    if (this._studying && this._index > 0) {
      this._index--;
      this._render();
    }
  },

  mark(knew) {
    if (!this._studying) return;
    const card = this._cards[this._index];
    if (this._marks[card.id] !== knew) {
      this._marks[card.id] = knew;
      DB.Progress.recordCard(this._setId, card.id, knew);
    }

    // Go to the next card in this round that has no verdict yet
    const n = this._cards.length;
    for (let step = 1; step <= n; step++) {
      const i = (this._index + step) % n;
      if (this._marks[this._cards[i].id] === undefined) {
        this._index = i;
        this._render();
        return;
      }
    }
    this._endRound();
  },

  shuffle() {
    if (!this._studying) return;
    this._cards = Utils.shuffle(this._cards);
    this._index = 0;
    this._render();
    Toast.show('Cards shuffled.');
  },

  restart() {
    this._begin();
  },

  _endRound() {
    const missed = this._cards.filter(c => this._marks[c.id] === false);
    const known  = this._cards.length - missed.length;
    this._studying = false;
    document.getElementById('fc-study').classList.add('hidden');

    // The first pass is the "real" score for the session log
    if (this._round === 1) {
      this._firstPass = { correct: known, total: this._cards.length };
      DB.Progress.recordSession(this._setId, known, this._cards.length);
      DB.Sessions.log(this._setId, 'flashcards', known, this._cards.length, Date.now() - this._startMs);
    }

    if (missed.length === 0) { this._showComplete(); return; }

    this._missed = missed;
    const n = missed.length;
    _renderResult('fc', {
      title: 'Round ' + this._round + ' complete',
      sub:   'You knew ' + known + ' of ' + this._cards.length + '. The ' + n + ' you missed ' +
             (n === 1 ? 'comes' : 'come') + ' back next.',
      stats: [
        { value: known, label: 'Got it',         cls: 'correct' },
        { value: n,     label: 'Still learning', cls: 'wrong' },
      ],
      extra:   _missedList('Coming back', missed),
      actions: [
        { label: 'Stop for now', onClick: () => App.navigate('sets') },
        { label: 'Review ' + n + (n === 1 ? ' missed card' : ' missed cards'), primary: true, onClick: () => this.nextRound() },
      ],
    });
  },

  nextRound() {
    this._round++;
    this._cards  = Utils.shuffle(this._missed);
    this._marks  = {};
    this._index  = 0;
    this._showStudy();
    this._render();
  },

  _showComplete() {
    const fp     = this._firstPass || { correct: this._all.length, total: this._all.length };
    const rounds = this._round;
    const dur    = Date.now() - this._startMs;
    _renderResult('fc', {
      title: 'You know every card',
      sub:   this._all.length + ' cards learned in ' + rounds + (rounds === 1 ? ' round' : ' rounds') +
             ' — ' + Utils.formatDuration(dur),
      stats: [
        { value: fp.correct + ' / ' + fp.total, label: 'Known on the first pass', cls: 'correct' },
        { value: rounds, label: rounds === 1 ? 'Round' : 'Rounds', cls: 'neutral' },
      ],
      actions: [
        { label: 'Study again', onClick: () => this._begin() },
        { label: 'Start a lesson', onClick: () => App.navigate('lesson') },
        { label: 'Speed Round', primary: true, onClick: () => App.navigate('speed') },
      ],
    });
  },
};

/* ============================================
   LEARN PAGE
   ============================================ */

const LearnPage = {
  _queue:    [],
  _index:    0,
  _correct:  0,
  _wrong:    0,
  _answered: false,
  _setId:    null,
  _startMs:  0,
  _allCards: [],

  init() {
    const setId = App.activeSetId;
    if (!setId) { App.navigate('sets'); return; }
    const set = DB.Sets.get(setId);
    if (!set || set.cards.length === 0) { App.navigate('sets'); return; }

    this._setId    = setId;
    this._allCards = set.cards;
    this._startMs  = Date.now();

    document.getElementById('learn-title').textContent = set.title;
    document.getElementById('learn-sub').textContent   = set.subject;

    document.getElementById('learn-result').classList.add('hidden');
    document.getElementById('learn-card-wrap').classList.remove('hidden');

    DB.Meta.recordStudyDay();
    this.restart();
  },

  restart() {
    // Prioritise cards that have been wrong more, then unseen
    const p = DB.Progress.forSet(this._setId);
    this._queue = Utils.shuffle(this._allCards).map(c => {
      const stat = p.cards?.[c.id];
      const weight = stat ? (stat.incorrect - stat.correct) : 0;
      return { card: c, weight };
    }).sort((a, b) => b.weight - a.weight).map(x => x.card);

    this._index    = 0;
    this._correct  = 0;
    this._wrong    = 0;
    this._answered = false;
    this._startMs  = Date.now();

    document.getElementById('learn-result').classList.add('hidden');
    document.getElementById('learn-card-wrap').classList.remove('hidden');

    this._render();
  },

  _render() {
    const card    = this._queue[this._index];
    const total   = this._queue.length;
    const remain  = total - this._index;
    const pct     = Math.round((this._index / total) * 100);

    document.getElementById('learn-progress-fill').style.width  = pct + '%';
    document.getElementById('learn-progress-text').textContent  = this._index + ' / ' + total;
    document.getElementById('lsc-correct').textContent  = this._correct + ' correct';
    document.getElementById('lsc-wrong').textContent    = this._wrong + ' incorrect';
    document.getElementById('lsc-remain').textContent   = remain + ' remaining';

    document.getElementById('learn-question').textContent = card.definition;
    document.getElementById('learn-feedback').className   = 'quiz-feedback hidden';
    document.getElementById('learn-next-btn').classList.add('hidden');
    this._answered = false;

    const options = Utils.buildOptions(this._allCards, card, 'term', Math.min(4, this._allCards.length));
    const container = document.getElementById('learn-options');
    container.innerHTML = '';
    const keys = ['A', 'B', 'C', 'D'];
    options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-option';
      btn.innerHTML = `<span class="opt-key">${keys[i]}</span>${_esc(opt)}`;
      btn.addEventListener('click', () => this._select(opt, card.term));
      container.appendChild(btn);
    });
  },

  _select(chosen, correct) {
    if (this._answered) return;
    this._answered = true;
    const isCorrect = chosen === correct;
    if (isCorrect) this._correct++; else this._wrong++;
    DB.Progress.recordCard(this._setId, this._queue[this._index].id, isCorrect);

    // Style options
    document.querySelectorAll('#learn-options .quiz-option').forEach(btn => {
      btn.classList.add('disabled');
      const text = btn.textContent.slice(1); // strip key letter
      if (text === correct)      btn.classList.add('correct');
      else if (text === chosen)  btn.classList.add('wrong');
    });

    const fb = document.getElementById('learn-feedback');
    fb.className = 'quiz-feedback ' + (isCorrect ? 'correct' : 'wrong');
    fb.textContent = isCorrect
      ? 'Correct!'
      : 'The correct answer was: ' + correct;

    document.getElementById('learn-next-btn').classList.remove('hidden');
  },

  next() {
    this._index++;
    if (this._index >= this._queue.length) {
      this._finish();
    } else {
      this._render();
    }
  },

  _finish() {
    const dur = Date.now() - this._startMs;
    const pct = Utils.pct(this._correct, this._queue.length);
    DB.Progress.recordSession(this._setId, this._correct, this._queue.length);
    DB.Sessions.log(this._setId, 'learn', this._correct, this._queue.length, dur);

    document.getElementById('learn-card-wrap').classList.add('hidden');
    document.getElementById('learn-result').classList.remove('hidden');
    document.getElementById('learn-result-sub').textContent =
      pct + '% — ' + Utils.grade(pct) + ' — ' + Utils.formatDuration(dur);

    const stats = document.getElementById('learn-result-stats');
    stats.innerHTML = `
      <div class="result-stat-card correct">
        <span class="result-stat-val">${this._correct}</span>Correct
      </div>
      <div class="result-stat-card wrong">
        <span class="result-stat-val">${this._wrong}</span>Incorrect
      </div>
    `;
  },
};

/* ============================================
   QUIZ PAGE
   ============================================ */

const QuizPage = {
  _questions: [],
  _answers:   [],
  _index:     0,
  _setId:     null,
  _startMs:   0,
  _allCards:  [],

  init() {
    const setId = App.activeSetId;
    if (!setId) { App.navigate('sets'); return; }
    const set = DB.Sets.get(setId);
    if (!set || set.cards.length === 0) { App.navigate('sets'); return; }

    this._setId    = setId;
    this._allCards = set.cards;

    document.getElementById('quiz-title').textContent = set.title;
    document.getElementById('quiz-sub').textContent   = set.subject;
    document.getElementById('quiz-result').classList.add('hidden');
    document.getElementById('quiz-active-section').classList.remove('hidden');

    DB.Meta.recordStudyDay();
    this.restart();
  },

  restart() {
    const cards = Utils.shuffle(this._allCards).slice(0, Math.min(10, this._allCards.length));
    this._questions = cards.map(c => ({
      card:    c,
      prompt:  c.term,
      correct: c.definition,
      options: Utils.buildOptions(this._allCards, c, 'definition', Math.min(4, this._allCards.length)),
    }));
    this._answers = new Array(this._questions.length).fill(null);
    this._index   = 0;
    this._startMs = Date.now();

    document.getElementById('quiz-result').classList.add('hidden');
    document.getElementById('quiz-active-section').classList.remove('hidden');
    this._render();
  },

  _render() {
    const q     = this._questions[this._index];
    const total = this._questions.length;
    const pct   = Math.round(((this._index + 1) / total) * 100);
    const answered = this._answers[this._index];

    document.getElementById('quiz-progress-fill').style.width   = pct + '%';
    document.getElementById('quiz-progress-text').textContent   = (this._index + 1) + ' / ' + total;
    document.getElementById('quiz-q-label').textContent         = 'Question ' + (this._index + 1);
    document.getElementById('quiz-question').textContent        = q.prompt;

    const container = document.getElementById('quiz-options');
    container.innerHTML = '';
    const keys = ['A', 'B', 'C', 'D'];
    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-option' + (answered !== null ? ' disabled' : '');
      btn.innerHTML = `<span class="opt-key">${keys[i]}</span>${_esc(opt)}`;
      if (answered !== null) {
        if (opt === q.correct)               btn.classList.add('correct');
        else if (opt === answered && opt !== q.correct) btn.classList.add('wrong');
      }
      btn.addEventListener('click', () => this._select(opt));
      container.appendChild(btn);
    });

    const fb = document.getElementById('quiz-feedback');
    if (answered !== null) {
      const isCorrect = answered === q.correct;
      fb.className = 'quiz-feedback ' + (isCorrect ? 'correct' : 'wrong');
      fb.textContent = isCorrect
        ? 'Correct!'
        : 'The correct answer was: ' + q.correct;
    } else {
      fb.className = 'quiz-feedback hidden';
      fb.textContent = '';
    }

    const nextBtn = document.getElementById('quiz-next-btn');
    nextBtn.textContent = this._index < total - 1 ? 'Next' : 'Finish';
  },

  _select(chosen) {
    if (this._answers[this._index] !== null) return;
    this._answers[this._index] = chosen;
    DB.Progress.recordCard(
      this._setId,
      this._questions[this._index].card.id,
      chosen === this._questions[this._index].correct
    );
    this._render();
  },

  next() {
    if (this._index < this._questions.length - 1) {
      this._index++;
      this._render();
    } else {
      this._finish();
    }
  },

  prev() {
    if (this._index > 0) {
      this._index--;
      this._render();
    }
  },

  _finish() {
    const dur     = Date.now() - this._startMs;
    const correct = this._answers.filter((a, i) => a === this._questions[i].correct).length;
    const total   = this._questions.length;
    const pct     = Utils.pct(correct, total);

    DB.Progress.recordSession(this._setId, correct, total);
    DB.Sessions.log(this._setId, 'quiz', correct, total, dur);

    document.getElementById('quiz-active-section').classList.add('hidden');
    document.getElementById('quiz-result').classList.remove('hidden');
    document.getElementById('quiz-result-title').textContent = 'Quiz Complete — ' + pct + '%';
    document.getElementById('quiz-result-sub').textContent   =
      Utils.grade(pct) + ' — ' + Utils.formatDuration(dur);

    const stats = document.getElementById('quiz-result-stats');
    stats.innerHTML = `
      <div class="result-stat-card correct">
        <span class="result-stat-val">${correct}</span>Correct
      </div>
      <div class="result-stat-card wrong">
        <span class="result-stat-val">${total - correct}</span>Incorrect
      </div>
    `;
  },
};

/* ============================================
   MATCH GAME PAGE
   ============================================ */

const MatchPage = {
  _selected:  null,
  _matched:   0,
  _total:     0,
  _timerInt:  null,
  _secs:      0,
  _started:   false,
  _tiles:     [],
  _setId:     null,

  init() {
    const setId = App.activeSetId;
    if (!setId) { App.navigate('sets'); return; }
    const set = DB.Sets.get(setId);
    if (!set || set.cards.length === 0) { App.navigate('sets'); return; }
    this._setId = setId;
    this._set   = set;
    DB.Meta.recordStudyDay();
    this._build();
  },

  _build() {
    clearInterval(this._timerInt);
    this._selected = null;
    this._matched  = 0;
    this._secs     = 0;
    this._started  = false;
    document.getElementById('match-timer-display').textContent = '0.0s';
    document.getElementById('match-result').classList.add('hidden');

    // Pick up to 6 pairs
    const cards = Utils.shuffle(this._set.cards).slice(0, 6);
    this._total = cards.length;

    const tiles = [];
    cards.forEach((c, i) => {
      tiles.push({ id: 'term-' + i,  pairId: 'def-' + i,  text: c.term,       type: 'term', cardId: c.id });
      tiles.push({ id: 'def-'  + i,  pairId: 'term-' + i, text: c.definition, type: 'def',  cardId: c.id });
    });
    this._tiles = Utils.shuffle(tiles);

    const grid = document.getElementById('match-grid');
    grid.innerHTML = '';
    this._tiles.forEach(t => {
      const div = document.createElement('div');
      div.className   = 'match-tile';
      div.id          = 'mt-' + t.id;
      div.textContent = t.text;
      div.dataset.id     = t.id;
      div.dataset.pairid = t.pairId;
      div.addEventListener('click', () => this._click(t.id, t.pairId, div));
      grid.appendChild(div);
    });
  },

  stop() { clearInterval(this._timerInt); },

  _startTimer() {
    if (this._started) return;
    this._started = true;
    this._timerInt = setInterval(() => {
      this._secs += 0.1;
      document.getElementById('match-timer-display').textContent = this._secs.toFixed(1) + 's';
    }, 100);
  },

  _click(id, pairId, el) {
    if (el.classList.contains('matched')) return;
    this._startTimer();

    if (this._selected === null) {
      this._selected = { id, pairId, el };
      el.classList.add('selected');
      return;
    }

    const prev = this._selected;
    this._selected = null;

    if (prev.id === id) {
      // Clicked same tile — deselect
      prev.el.classList.remove('selected');
      return;
    }

    if (prev.pairId === id) {
      // Match
      prev.el.classList.remove('selected');
      prev.el.classList.add('matched');
      el.classList.add('matched');
      this._matched++;
      DB.Progress.recordCard(this._setId, this._tiles.find(t => t.id === id)?.cardId, true);

      if (this._matched === this._total) {
        this._finish();
      }
    } else {
      // No match
      prev.el.classList.add('shake');
      el.classList.add('shake');
      prev.el.classList.remove('selected');
      setTimeout(() => {
        prev.el.classList.remove('shake');
        el.classList.remove('shake');
      }, 300);
    }
  },

  _finish() {
    clearInterval(this._timerInt);
    const time = this._secs.toFixed(1);
    DB.Sessions.log(this._setId, 'match', this._total, this._total, Math.round(this._secs * 1000));

    const result = document.getElementById('match-result');
    result.classList.remove('hidden');
    document.getElementById('match-result-sub').textContent =
      'Finished in ' + time + 's with ' + this._total + ' pairs matched.';
  },
};

/* ============================================
   WRITE PAGE
   Type the term for each definition. Forgiving about
   case, punctuation, accents and small typos. Missed
   cards come back until you get every one.
   ============================================ */

const WritePage = {
  _set: null, _q: null, _card: null, _state: 'ask', _startMs: 0,

  init() {
    const set = _studySet(1);
    if (!set) return;
    this._set = set;
    document.getElementById('write-title').textContent = set.title;
    document.getElementById('write-sub').textContent   = set.subject + ' — type the term that matches each definition';
    document.getElementById('write-input').onkeydown = e => {
      if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this._enter(); }
    };
    DB.Meta.recordStudyDay();
    this.restart();
  },

  restart() {
    this._q       = new CardQueue(this._set.cards);
    this._startMs = Date.now();
    document.getElementById('write-result').classList.add('hidden');
    document.getElementById('write-active').classList.remove('hidden');
    this._render();
  },

  _render() {
    const q = this._q, card = q.current;
    this._card  = card;
    this._state = 'ask';
    _queueProgress('write', q);

    document.getElementById('write-label').textContent =
      q.missed.has(card.id) ? 'Try again — type the term for:' : 'Type the term for:';
    document.getElementById('write-question').textContent = card.definition;

    const input = document.getElementById('write-input');
    input.value = '';
    input.readOnly = false;
    input.className = 'form-input';
    document.getElementById('write-feedback').className = 'quiz-feedback hidden';
    document.getElementById('write-check').classList.remove('hidden');
    document.getElementById('write-skip').classList.remove('hidden');
    document.getElementById('write-override').classList.add('hidden');
    document.getElementById('write-next').classList.add('hidden');
    input.focus();
  },

  _enter() { if (this._state === 'ask') this.submit(); else this.next(); },

  submit() {
    if (this._state !== 'ask') return;
    const input = document.getElementById('write-input');
    if (!input.value.trim()) return;
    const res = Utils.checkTyped(input.value, this._card.term);
    this._settle(res !== 'wrong', res === 'close', false);
  },

  dontKnow() {
    if (this._state !== 'ask') return;
    this._settle(false, false, true);
  },

  _settle(ok, close, gaveUp) {
    this._state = ok ? 'right' : 'wrong';
    DB.Progress.recordCard(this._set.id, this._card.id, ok);

    const input = document.getElementById('write-input');
    input.readOnly = true;
    input.classList.add(ok ? 'correct' : 'wrong');

    const fb = document.getElementById('write-feedback');
    fb.className = 'quiz-feedback ' + (ok ? 'correct' : 'wrong');
    fb.textContent = ok
      ? (close ? 'Correct — mind the spelling: ' + this._card.term : 'Correct!')
      : 'The answer was: ' + this._card.term;

    document.getElementById('write-check').classList.add('hidden');
    document.getElementById('write-skip').classList.add('hidden');
    document.getElementById('write-override').classList.toggle('hidden', ok || gaveUp);
    document.getElementById('write-next').classList.remove('hidden');
  },

  // Typed a valid variant the checker didn't accept
  override() {
    if (this._state !== 'wrong') return;
    this._state = 'right';
    DB.Progress.recordCard(this._set.id, this._card.id, true);
    document.getElementById('write-input').className = 'form-input correct';
    const fb = document.getElementById('write-feedback');
    fb.className = 'quiz-feedback correct';
    fb.textContent = 'Marked as correct.';
    document.getElementById('write-override').classList.add('hidden');
  },

  next() {
    if (this._state !== 'right' && this._state !== 'wrong') return;
    if (this._state === 'right') this._q.pass(); else this._q.fail();
    if (this._q.done) {
      this._state = 'done';
      document.getElementById('write-active').classList.add('hidden');
      _finishQueueGame('write', 'write', this._set.id, this._q, this._startMs, () => this.restart());
    } else {
      this._render();
    }
  },
};

/* ============================================
   SPEED ROUND
   60 seconds of multiple choice. Streaks raise your
   multiplier, wrong answers cost 3 seconds. Best score
   is saved per set.
   ============================================ */

const SpeedPage = {
  DURATION: 60000,
  PENALTY:  3000,

  _set: null, _deck: [], _last: null, _card: null,
  _timer: null, _nextT: null, _running: false, _locked: false, _endAt: 0,
  _score: 0, _streak: 0, _bestStreak: 0, _right: 0, _total: 0, _missed: new Map(),

  init() {
    const set = _studySet(2);
    if (!set) return;
    this.stop();
    this._set = set;
    document.getElementById('speed-title').textContent = set.title;
    document.getElementById('speed-sub').textContent   = set.subject;
    const best = DB.Scores.get(set.id, 'speed');
    document.getElementById('speed-best').textContent  = best ? 'Your best on this set: ' + best + ' points' : 'No score yet — set the first one.';
    document.getElementById('speed-intro').classList.remove('hidden');
    document.getElementById('speed-play').classList.add('hidden');
    document.getElementById('speed-result').classList.add('hidden');
    DB.Meta.recordStudyDay();
  },

  stop() {
    clearInterval(this._timer);
    clearTimeout(this._nextT);
    this._timer = this._nextT = null;
    this._running = false;
  },

  start() {
    this.stop();
    this._deck = []; this._last = null;
    this._score = 0; this._streak = 0; this._bestStreak = 0;
    this._right = 0; this._total = 0; this._missed = new Map();
    document.getElementById('speed-intro').classList.add('hidden');
    document.getElementById('speed-result').classList.add('hidden');
    document.getElementById('speed-play').classList.remove('hidden');

    this._running = true;
    this._endAt   = Date.now() + this.DURATION;
    this._hud();
    this._tick();
    this._timer = setInterval(() => this._tick(), 100);
    this._nextQuestion();
  },

  _tick() {
    const left = Math.max(0, this._endAt - Date.now());
    const clock = document.getElementById('speed-clock');
    clock.textContent = (left / 1000).toFixed(1) + 's';
    clock.classList.toggle('low', left < 10000);
    document.getElementById('speed-bar').style.width = Utils.pct(left, this.DURATION) + '%';
    if (left <= 0) this._end();
  },

  _mult() { return Math.min(4, 1 + Math.floor(this._streak / 3)); },

  _hud() {
    document.getElementById('speed-score').textContent  = this._score + ' pts';
    document.getElementById('speed-streak').textContent = 'Streak ' + this._streak + ' · ×' + this._mult();
  },

  _draw() {
    if (!this._deck.length) {
      this._deck = Utils.shuffle(this._set.cards);
      if (this._deck.length > 1 && this._deck[0].id === this._last) this._deck.push(this._deck.shift());
    }
    return this._deck.shift();
  },

  _nextQuestion() {
    if (!this._running) return;
    const card = this._draw();
    this._card = card; this._last = card.id; this._locked = false;
    document.getElementById('speed-question').textContent = card.definition;

    const all  = this._set.cards;
    const opts = Utils.buildOptions(all, card, 'term', Math.min(4, all.length));
    const box  = document.getElementById('speed-options');
    box.innerHTML = '';
    const keys = ['A', 'B', 'C', 'D'];
    opts.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-option';
      btn.dataset.val = opt;
      btn.innerHTML = `<span class="opt-key">${keys[i]}</span>${_esc(opt)}`;
      btn.addEventListener('click', () => this._pick(opt));
      box.appendChild(btn);
    });
  },

  _pick(opt) {
    if (!this._running || this._locked) return;
    this._locked = true;
    const card = this._card;
    const ok   = opt === card.term;
    this._total++;
    DB.Progress.recordCard(this._set.id, card.id, ok);

    document.querySelectorAll('#speed-options .quiz-option').forEach(b => {
      b.classList.add('disabled');
      if (b.dataset.val === card.term) b.classList.add('correct');
      else if (b.dataset.val === opt)  b.classList.add('wrong');
    });

    if (ok) {
      this._right++;
      this._streak++;
      this._bestStreak = Math.max(this._bestStreak, this._streak);
      this._score += 10 * this._mult();
    } else {
      this._streak = 0;
      this._endAt -= this.PENALTY;
      this._missed.set(card.id, card);
    }
    this._hud();
    this._nextT = setTimeout(() => this._nextQuestion(), ok ? 220 : 800);
  },

  _end() {
    if (!this._running) return;
    this.stop();
    const set = this._set;
    const { best, isNew } = DB.Scores.submit(set.id, 'speed', this._score);
    if (this._total > 0) DB.Progress.recordSession(set.id, this._right, this._total);
    DB.Sessions.log(set.id, 'speed', this._right, this._total, this.DURATION);

    document.getElementById('speed-play').classList.add('hidden');
    const acc = Utils.pct(this._right, this._total);
    _renderResult('speed', {
      title: 'Time\u2019s up — ' + this._score + ' points',
      sub:   isNew && this._score > 0 ? 'New best for this set!' : 'Best on this set: ' + best + ' points',
      stats: [
        { value: this._right,             label: 'Correct',     cls: 'correct' },
        { value: this._total - this._right, label: 'Wrong',     cls: this._total - this._right ? 'wrong' : 'neutral' },
        { value: this._bestStreak,        label: 'Best streak', cls: 'neutral' },
        { value: acc + '%',               label: 'Accuracy',    cls: 'neutral' },
      ],
      extra:   _missedList('Worth another look', [...this._missed.values()]),
      actions: [
        { label: 'Play again', primary: true, onClick: () => this.start() },
        { label: 'Back to flashcards', onClick: () => App.navigate('flashcards') },
      ],
    });
  },
};

/* ============================================
   HANGMAN
   The definition is the clue; guess the term letter by
   letter. Six wrong guesses and you lose that card, but it
   comes back later. Terms without Latin letters are skipped.
   ============================================ */

const HangmanPage = {
  MAX: 6,
  _set: null, _eligible: [], _q: null, _card: null,
  _guessed: new Set(), _wrong: 0, _state: 'play', _startMs: 0,

  _base(ch)     { return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); },
  _isLetter(ch) { return /^[a-z]$/.test(this._base(ch)); },
  _letters(term) {
    return [...new Set(Array.from(term).filter(c => this._isLetter(c)).map(c => this._base(c)))];
  },

  init() {
    const set = _studySet(1);
    if (!set) return;
    const eligible = set.cards.filter(c => this._letters(c.term).length > 0);
    if (!eligible.length) {
      Toast.show('Hangman needs terms that contain Latin letters.', 'error', 3200);
      App.navigate('sets');
      return;
    }
    this._set      = set;
    this._eligible = eligible;
    document.getElementById('hm-title').textContent = set.title;
    document.getElementById('hm-sub').textContent   = set.subject + ' — guess the term from its definition' +
      (eligible.length < set.cards.length ? ' (' + eligible.length + ' of ' + set.cards.length + ' terms playable)' : '');

    const keys = document.getElementById('hm-keys');
    keys.innerHTML = '';
    'abcdefghijklmnopqrstuvwxyz'.split('').forEach(l => {
      const b = document.createElement('button');
      b.className = 'hm-key';
      b.textContent = l.toUpperCase();
      b.dataset.letter = l;
      b.addEventListener('click', () => this.guess(l));
      keys.appendChild(b);
    });

    DB.Meta.recordStudyDay();
    this.restart();
  },

  restart() {
    this._q       = new CardQueue(this._eligible);
    this._startMs = Date.now();
    document.getElementById('hm-result').classList.add('hidden');
    document.getElementById('hm-active').classList.remove('hidden');
    this._round();
  },

  _round() {
    const q = this._q, card = q.current;
    this._card    = card;
    this._guessed = new Set();
    this._wrong   = 0;
    this._state   = 'play';
    _queueProgress('hm', q);

    document.getElementById('hm-label').textContent =
      q.missed.has(card.id) ? 'Try again — guess the term for:' : 'Guess the term for:';
    document.getElementById('hm-clue').textContent = card.definition;
    document.getElementById('hm-feedback').className = 'quiz-feedback hidden';
    document.getElementById('hm-hint').classList.remove('hidden');
    document.getElementById('hm-giveup').classList.remove('hidden');
    document.getElementById('hm-next').classList.add('hidden');
    document.querySelectorAll('#hm-keys .hm-key').forEach(k => { k.className = 'hm-key'; k.disabled = false; });
    this._draw(false);
  },

  _draw(reveal) {
    const wrap = document.getElementById('hm-word');
    wrap.innerHTML = '';
    let word = null;
    Array.from(this._card.term).forEach(ch => {
      if (/\s/.test(ch)) { word = null; return; }
      if (!word) { word = document.createElement('div'); word.className = 'hm-w'; wrap.appendChild(word); }
      const slot = document.createElement('span');
      slot.className = 'hm-slot';
      if (!this._isLetter(ch)) {
        slot.textContent = ch;
        slot.classList.add('fixed');
      } else if (this._guessed.has(this._base(ch))) {
        slot.textContent = ch;
      } else if (reveal) {
        slot.textContent = ch;
        slot.classList.add('miss');
      }
      word.appendChild(slot);
    });

    document.querySelectorAll('#hm-svg .hm-part').forEach((p, i) => p.classList.toggle('show', i < this._wrong));
    const left = this.MAX - this._wrong;
    document.getElementById('hm-lives').textContent = left + (left === 1 ? ' life left' : ' lives left');
  },

  guess(letter) {
    if (this._state !== 'play' || this._guessed.has(letter)) return;
    this._guessed.add(letter);
    const hit = this._letters(this._card.term).includes(letter);
    const key = document.querySelector(`#hm-keys .hm-key[data-letter="${letter}"]`);
    if (key) { key.classList.add(hit ? 'hit' : 'miss'); key.disabled = true; }
    if (!hit) this._wrong++;
    this._draw(false);
    this._check();
  },

  hint() {
    if (this._state !== 'play' || this._wrong >= this.MAX - 1) return;
    const unseen = this._letters(this._card.term).filter(l => !this._guessed.has(l));
    if (!unseen.length) return;
    const letter = unseen[Math.floor(Math.random() * unseen.length)];
    this._guessed.add(letter);
    const key = document.querySelector(`#hm-keys .hm-key[data-letter="${letter}"]`);
    if (key) { key.classList.add('hit'); key.disabled = true; }
    this._wrong++;                       // a hint costs a life
    this._draw(false);
    this._check();
  },

  giveUp() { if (this._state === 'play') this._settle(false); },

  _check() {
    if (this._letters(this._card.term).every(l => this._guessed.has(l))) this._settle(true);
    else if (this._wrong >= this.MAX) this._settle(false);
  },

  _settle(won) {
    this._state = won ? 'won' : 'lost';
    DB.Progress.recordCard(this._set.id, this._card.id, won);
    this._draw(!won);
    document.querySelectorAll('#hm-keys .hm-key').forEach(k => { k.disabled = true; });
    const fb = document.getElementById('hm-feedback');
    fb.className = 'quiz-feedback ' + (won ? 'correct' : 'wrong');
    fb.textContent = won ? 'Solved!' : 'The answer was: ' + this._card.term;
    document.getElementById('hm-hint').classList.add('hidden');
    document.getElementById('hm-giveup').classList.add('hidden');
    document.getElementById('hm-next').classList.remove('hidden');
  },

  next() {
    if (this._state !== 'won' && this._state !== 'lost') return;
    if (this._state === 'won') this._q.pass(); else this._q.fail();
    if (this._q.done) {
      this._state = 'done';
      document.getElementById('hm-active').classList.add('hidden');
      _finishQueueGame('hm', 'hangman', this._set.id, this._q, this._startMs, () => this.restart());
    } else {
      this._round();
    }
  },
};

/* ============================================
   TRUE / FALSE
   A term and a definition: do they belong together?
   Missed cards come back until you get every one.
   ============================================ */

const TFPage = {
  _set: null, _q: null, _card: null, _isTrue: true, _state: 'ask', _startMs: 0, _t: null,

  init() {
    const set = _studySet(2);
    if (!set) return;
    this._set = set;
    document.getElementById('tf-title').textContent = set.title;
    document.getElementById('tf-sub').textContent   = set.subject + ' — decide if each definition matches its term';
    DB.Meta.recordStudyDay();
    this.restart();
  },

  stop() { clearTimeout(this._t); this._t = null; },

  restart() {
    this.stop();
    this._q       = new CardQueue(this._set.cards);
    this._startMs = Date.now();
    document.getElementById('tf-result').classList.add('hidden');
    document.getElementById('tf-active').classList.remove('hidden');
    this._render();
  },

  _render() {
    const q = this._q, card = q.current;
    this._card  = card;
    this._state = 'ask';
    _queueProgress('tf', q);

    // A false pairing borrows the definition of a different card
    const others = this._set.cards.filter(c => c.id !== card.id && c.definition !== card.definition);
    this._isTrue = !others.length || Math.random() < 0.5;
    const shown  = this._isTrue ? card.definition : others[Math.floor(Math.random() * others.length)].definition;

    document.getElementById('tf-term').textContent = card.term;
    document.getElementById('tf-def').textContent  = shown;
    ['tf-true', 'tf-false'].forEach(id => { const b = document.getElementById(id); b.className = 'tf-btn'; b.disabled = false; });
    document.getElementById('tf-feedback').className = 'quiz-feedback hidden';
    document.getElementById('tf-next').classList.add('hidden');
  },

  answer(guess) {
    if (this._state !== 'ask') return;
    const ok = guess === this._isTrue;
    this._state = ok ? 'right' : 'wrong';
    DB.Progress.recordCard(this._set.id, this._card.id, ok);

    const trueBtn = document.getElementById('tf-true'), falseBtn = document.getElementById('tf-false');
    trueBtn.disabled = falseBtn.disabled = true;
    (this._isTrue ? trueBtn : falseBtn).classList.add('correct');
    if (!ok) (guess ? trueBtn : falseBtn).classList.add('wrong');

    const fb = document.getElementById('tf-feedback');
    fb.className = 'quiz-feedback ' + (ok ? 'correct' : 'wrong');
    if (ok) {
      fb.textContent = 'Correct!';
      this._t = setTimeout(() => this.next(), 700);
    } else {
      fb.textContent = this._isTrue
        ? 'Not quite — that definition does match.'
        : 'Not quite — the real definition is: ' + this._card.definition;
      document.getElementById('tf-next').classList.remove('hidden');
    }
  },

  next() {
    if (this._state !== 'right' && this._state !== 'wrong') return;
    this.stop();
    if (this._state === 'right') this._q.pass(); else this._q.fail();
    if (this._q.done) {
      this._state = 'done';
      document.getElementById('tf-active').classList.add('hidden');
      _finishQueueGame('tf', 'truefalse', this._set.id, this._q, this._startMs, () => this.restart());
    } else {
      this._render();
    }
  },
};

/* ============================================
   SPEECH (optional)
   Uses the browser's built-in voices. Listening exercises
   only exist when a voice is installed for the language
   the person picks, so nothing is ever read in the wrong
   accent.
   ============================================ */

const Speech = {
  _voices: [],

  ok() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window &&
           typeof window.SpeechSynthesisUtterance !== 'undefined';
  },

  load(cb) {
    if (!this.ok()) { cb([]); return; }
    const grab = () => { this._voices = window.speechSynthesis.getVoices() || []; return this._voices.length; };
    if (grab()) { cb(this._voices); return; }
    let done = false;
    const fin = () => { if (done) return; done = true; grab(); cb(this._voices); };
    try { window.speechSynthesis.addEventListener('voiceschanged', fin, { once: true }); } catch (e) { /* ignore */ }
    setTimeout(fin, 800);
  },

  // [{ tag, label }] for every language that has an installed voice
  languages() {
    let names = null;
    try { names = new Intl.DisplayNames(['en'], { type: 'language' }); } catch (e) { /* ignore */ }
    const seen = new Map();
    this._voices.forEach(v => {
      if (!v.lang || seen.has(v.lang)) return;
      let label = v.lang;
      try { label = (names && names.of(v.lang.replace('_', '-'))) || v.lang; } catch (e) { /* ignore */ }
      seen.set(v.lang, label);
    });
    return [...seen].map(([tag, label]) => ({ tag, label })).sort((a, b) => a.label.localeCompare(b.label));
  },

  voiceFor(tag) {
    if (!tag) return null;
    const base = tag.split(/[-_]/)[0].toLowerCase();
    return this._voices.find(v => v.lang === tag) ||
           this._voices.find(v => (v.lang || '').split(/[-_]/)[0].toLowerCase() === base) || null;
  },

  speak(text, tag, rate = 1) {
    if (!this.ok() || !tag) return;
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const u = new window.SpeechSynthesisUtterance(text);
      const v = this.voiceFor(tag);
      if (v) u.voice = v;
      u.lang = tag;
      u.rate = rate;
      synth.speak(u);
    } catch (e) { /* ignore */ }
  },

  cancel() {
    try { if (this.ok()) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  },
};

/* ============================================
   LESSON PAGE
   A mixed lesson, one exercise at a time: multiple choice,
   fill in the blank, build the definition, match pairs,
   typing and (when a voice exists) listening. Five hearts,
   XP, and anything missed repeats before the lesson ends.
   No speaking exercises.
   ============================================ */

const LessonPage = {
  HEARTS: 5,
  STOP: new Set(('the and that with from which their there this these those into such when where while also been ' +
    'have has for are was were its your they them than then onto over each other only used uses can may will ' +
    'about between during after before more most some any not but').split(' ')),

  _set: null, _lang: '', _queue: [], _ex: null, _total: 0, _done: 0,
  _hearts: 5, _xp: 0, _attempts: 0, _firstOk: 0, _mistakes: 0, _missed: new Map(), _startMs: 0,
  _sel: null, _built: [], _inputEl: null, _mSel: null, _playing: false, _audioT: null,

  /* ---------- setup ---------- */

  init() {
    const set = _studySet(1);
    if (!set) return;
    this.stop();
    this._set = set;
    document.getElementById('lesson-title').textContent = set.title;
    document.getElementById('lesson-sub').textContent   = set.subject + ' — ' + set.cards.length + ' cards';
    document.getElementById('lesson-intro').classList.remove('hidden');
    document.getElementById('lesson-play').classList.add('hidden');
    document.getElementById('lesson-result').classList.add('hidden');
    DB.Meta.recordStudyDay();
    Speech.load(() => { if (App.currentPage === 'lesson') this._fillLangs(); });
  },

  stop() {
    clearTimeout(this._audioT);
    this._audioT = null;
    this._playing = false;
    Speech.cancel();
  },

  quit() {
    this.stop();
    App.navigate('sets');
  },

  _pref(key, val) {
    try {
      if (val === undefined) return localStorage.getItem('quizly_lesson_' + key);
      localStorage.setItem('quizly_lesson_' + key, val);
    } catch (e) { /* storage unavailable */ }
    return null;
  },

  _fillLangs() {
    const sel   = document.getElementById('ls-lang');
    const note  = document.getElementById('ls-voice-note');
    const langs = Speech.languages();
    sel.innerHTML = '<option value="">Off</option>' +
      langs.map(l => `<option value="${_esc(l.tag)}">${_esc(l.label)}</option>`).join('');
    if (!langs.length) {
      sel.disabled = true;
      note.textContent = 'This browser has no speech voices installed, so listening exercises are switched off.';
      return;
    }
    sel.disabled = false;
    note.textContent = 'Pick the language your terms are written in to add listening exercises. Leave it Off to skip them.';
    const saved = this._pref('lang');
    if (saved && langs.some(l => l.tag === saved)) sel.value = saved;
  },

  /* ---------- building the lesson ---------- */

  start() {
    this.stop();
    const set = this._set;
    const len = parseInt(document.getElementById('ls-length').value, 10) || 12;
    const lang = document.getElementById('ls-lang').value;
    this._pref('lang', lang);
    this._lang = lang && Speech.voiceFor(lang) ? lang : '';

    this._queue    = this._build(len);
    this._total    = this._queue.length;
    this._done     = 0;
    this._hearts   = this.HEARTS;
    this._xp       = 0;
    this._attempts = 0;
    this._firstOk  = 0;
    this._mistakes = 0;
    this._missed   = new Map();
    this._startMs  = Date.now();
    this._playing  = true;

    document.getElementById('lesson-intro').classList.add('hidden');
    document.getElementById('lesson-result').classList.add('hidden');
    document.getElementById('lesson-play').classList.remove('hidden');
    this._render();
  },

  _clean(w)   { return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''); },
  _okWord(w)  { return w.length >= 4 && !this.STOP.has(w.toLowerCase()); },
  _tokens(s)  { return s.trim().split(/\s+/).filter(Boolean); },
  _caseOf(w)  { return w === w.toUpperCase() && /\p{Lu}/u.test(w) ? 'U' : /^\p{Lu}/u.test(w) ? 'C' : 'L'; },

  _blankable(card) {
    const t = this._tokens(card.definition);
    return t.length >= 5 && t.some(x => this._okWord(this._clean(x)));
  },

  _buildable(card) {
    const n = this._tokens(card.definition).length;
    return n >= 4 && n <= 16;
  },

  _eligible(card) {
    const many = this._set.cards.length >= 2;
    const t = ['type'];
    if (many) t.push('mc_def2term', 'mc_term2def', 'mc_def2term');
    if (this._blankable(card)) t.push('blank', 'blank');
    if (this._buildable(card)) t.push('build');
    if (this._lang) t.push(many ? 'listen_pick' : 'listen_type', 'listen_type');
    return t;
  },

  _build(n) {
    const cards = this._set.cards;
    const p = DB.Progress.forSet(this._set.id);
    const weight = c => { const s = p.cards && p.cards[c.id]; return s ? s.incorrect - s.correct : 0; };
    // weakest cards first, ties in random order
    this._pool = Utils.shuffle(cards).sort((a, b) => weight(b) - weight(a));

    const withMatch = cards.length >= 3 && n >= 8;
    const slots = n - (withMatch ? 1 : 0);
    const out = [];
    let last = '';
    for (let i = 0; i < slots; i++) {
      const card = this._pool[i % this._pool.length];
      const opts = this._eligible(card);
      const fresh = opts.filter(t => t !== last);
      const type = (fresh.length ? fresh : opts)[Math.floor(Math.random() * (fresh.length || opts.length))];
      out.push(this._make(type, card));
      last = type;
    }
    if (withMatch) out.splice(Math.min(3, out.length), 0, this._make('match', this._pool[0]));
    return out;
  },

  _make(type, card) {
    const cards = this._set.cards;
    const ex = { type, card, state: 'ask', failed: false, counted: false };
    const optN = Math.min(4, cards.length);

    if (type === 'mc_def2term' || type === 'listen_pick') ex.options = Utils.buildOptions(cards, card, 'term', optN);
    if (type === 'mc_term2def') ex.options = Utils.buildOptions(cards, card, 'definition', optN);

    if (type === 'blank') {
      const tokens = this._tokens(card.definition);
      const idx = tokens.map((t, i) => this._okWord(this._clean(t)) ? i : -1).filter(i => i >= 0);
      const gap = idx[Math.floor(Math.random() * idx.length)];
      const raw = tokens[gap];
      ex.tokens = tokens;
      ex.gap    = gap;
      ex.pre    = raw.match(/^[^\p{L}\p{N}]*/u)[0];
      ex.post   = raw.match(/[^\p{L}\p{N}]*$/u)[0];
      ex.answer = this._clean(raw);
      const cls = this._caseOf(ex.answer);
      const seen = new Set([ex.answer.toLowerCase()]);
      const pool = [];
      cards.forEach(c => {
        if (c.id === card.id) return;
        this._tokens(c.definition).forEach(t => {
          const w = this._clean(t);
          if (this._okWord(w) && !seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); pool.push(w); }
        });
      });
      const same  = Utils.shuffle(pool.filter(w => this._caseOf(w) === cls));
      const other = Utils.shuffle(pool.filter(w => this._caseOf(w) !== cls));
      const dis   = [...same, ...other].slice(0, 3);
      if (dis.length >= 2) ex.options = Utils.shuffle([ex.answer, ...dis]);
      else ex.typed = true;
    }

    if (type === 'build') {
      const words = this._tokens(card.definition);
      const have  = new Set(words.map(w => w.toLowerCase()));
      const extra = [];
      Utils.shuffle(cards.filter(c => c.id !== card.id)).forEach(c => {
        Utils.shuffle(this._tokens(c.definition)).forEach(t => {
          if (extra.length < 2 && !have.has(t.toLowerCase()) && !extra.includes(t)) extra.push(t);
        });
      });
      ex.words = words;
      ex.chips = Utils.shuffle([...words, ...extra].map((text, id) => ({ id, text })));
    }

    if (type === 'match') {
      const pairs = this._pool.slice(0, Math.min(5, this._pool.length));
      ex.pairs = pairs;
      ex.left  = Utils.shuffle(pairs);
      ex.right = Utils.shuffle(pairs);
      ex.mm = 0;
    }
    return ex;
  },

  /* ---------- rendering ---------- */

  _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  },

  _speakBtn(text) {
    const b = this._el('button', 'ls-speak');
    b.type = 'button';
    b.setAttribute('aria-label', 'Play audio');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14"/></svg>';
    b.addEventListener('click', () => Speech.speak(text, this._lang));
    return b;
  },

  _prompt(label, text, speak) {
    const c = this._el('div', 'quiz-prompt-card');
    c.appendChild(this._el('p', 'quiz-prompt-label', label));
    c.appendChild(this._el('p', 'quiz-question', text));
    if (speak && this._lang) c.appendChild(this._speakBtn(speak));
    return c;
  },

  _input(placeholder) {
    const i = this._el('input', 'form-input ls-input');
    i.type = 'text';
    i.placeholder = placeholder;
    i.autocomplete = 'off';
    i.autocapitalize = 'off';
    i.spellcheck = false;
    i.setAttribute('aria-label', 'Your answer');
    i.addEventListener('input', () => this._refresh());
    i.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this.primary(); } });
    this._inputEl = i;
    return i;
  },

  _optionList(opts) {
    const box = this._el('div', 'ls-options');
    opts.forEach((o, i) => {
      const b = this._el('button', 'ls-opt');
      b.type = 'button';
      b.dataset.val = o;
      b.innerHTML = `<span class="opt-key">${i + 1}</span><span class="ls-opt-text">${_esc(o)}</span>`;
      b.addEventListener('click', () => this._choose(b, o));
      box.appendChild(b);
    });
    return box;
  },

  _choose(btn, val) {
    if (!this._ex || this._ex.state !== 'ask') return;
    this._sel = val;
    document.querySelectorAll('#ls-body .ls-opt, #ls-body .ls-chip.pick').forEach(b => b.classList.toggle('selected', b === btn));
    if (this._ex.type === 'blank') {
      const g = document.getElementById('ls-gap');
      if (g) { g.textContent = val; g.classList.add('filled'); }
    }
    this._refresh();
  },

  _render() {
    const ex = this._queue[0];
    this._ex = ex;
    ex.state = 'ask';
    this._sel = null; this._built = []; this._inputEl = null; this._mSel = null;
    clearTimeout(this._audioT);
    Speech.cancel();

    const bar = document.getElementById('ls-bar');
    bar.className = 'ls-bar';
    document.getElementById('ls-msg').innerHTML = '';
    const check = document.getElementById('ls-check');
    check.textContent = 'Check';
    check.disabled = true;
    document.getElementById('ls-skip').classList.toggle('hidden', ex.type === 'match');
    check.classList.toggle('hidden', ex.type === 'match');

    const body = document.getElementById('ls-body');
    body.innerHTML = '';
    const instr = {
      mc_def2term: 'Which term matches this definition?',
      mc_term2def: 'What does this term mean?',
      blank:       'Fill in the missing word',
      type:        'Type the term',
      build:       'Build the definition',
      match:       'Tap the matching pairs',
      listen_pick: 'Tap what you hear',
      listen_type: 'Type what you hear',
    }[ex.type];
    document.getElementById('ls-instr').textContent = instr;
    this['_r_' + ex.type](ex, body);

    this._hud();
    this._refresh();
  },

  _hud() {
    document.getElementById('ls-fill').style.width = Utils.pct(this._done, this._total) + '%';
    const h = document.getElementById('ls-hearts');
    h.innerHTML = Array.from({ length: this.HEARTS }, (_, i) =>
      `<span class="heart${i >= this._hearts ? ' lost' : ''}">♥</span>`).join('');
    h.setAttribute('aria-label', this._hearts + ' hearts left');
  },

  _r_mc_def2term(ex, body) {
    body.appendChild(this._prompt('Definition', ex.card.definition));
    body.appendChild(this._optionList(ex.options));
  },

  _r_mc_term2def(ex, body) {
    body.appendChild(this._prompt('Term', ex.card.term, ex.card.term));
    body.appendChild(this._optionList(ex.options));
  },

  _r_listen_pick(ex, body) {
    const wrap = this._el('div', 'ls-listen');
    wrap.appendChild(this._speakBtn(ex.card.term));
    const slow = this._el('button', 'ls-speak slow');
    slow.type = 'button';
    slow.textContent = 'Slow';
    slow.addEventListener('click', () => Speech.speak(ex.card.term, this._lang, 0.6));
    wrap.appendChild(slow);
    body.appendChild(wrap);
    body.appendChild(this._optionList(ex.options));
    this._autoplay(ex);
  },

  _r_listen_type(ex, body) {
    const wrap = this._el('div', 'ls-listen');
    wrap.appendChild(this._speakBtn(ex.card.term));
    const slow = this._el('button', 'ls-speak slow');
    slow.type = 'button';
    slow.textContent = 'Slow';
    slow.addEventListener('click', () => Speech.speak(ex.card.term, this._lang, 0.6));
    wrap.appendChild(slow);
    body.appendChild(wrap);
    body.appendChild(this._input('Type what you hear'));
    this._inputEl.focus();
    this._autoplay(ex);
  },

  _autoplay(ex) {
    this._audioT = setTimeout(() => Speech.speak(ex.card.term, this._lang), 250);
  },

  _r_type(ex, body) {
    body.appendChild(this._prompt('Definition', ex.card.definition));
    body.appendChild(this._input('Type the term'));
    this._inputEl.focus();
  },

  _r_blank(ex, body) {
    body.appendChild(this._el('p', 'ls-context', 'Definition of ' + ex.card.term));
    const card = this._el('div', 'quiz-prompt-card ls-sentence');
    const p = this._el('p', 'quiz-question');
    ex.tokens.forEach((t, i) => {
      if (i > 0) p.appendChild(document.createTextNode(' '));
      if (i === ex.gap) {
        if (ex.pre) p.appendChild(document.createTextNode(ex.pre));
        const g = this._el('span', 'ls-gap', '');
        g.id = 'ls-gap';
        p.appendChild(g);
        if (ex.post) p.appendChild(document.createTextNode(ex.post));
      } else {
        p.appendChild(document.createTextNode(t));
      }
    });
    card.appendChild(p);
    body.appendChild(card);

    if (ex.typed) {
      body.appendChild(this._input('Type the missing word'));
      this._inputEl.focus();
    } else {
      const bank = this._el('div', 'ls-bank pick-bank');
      ex.options.forEach(o => {
        const b = this._el('button', 'ls-chip pick', o);
        b.type = 'button';
        b.dataset.val = o;
        b.addEventListener('click', () => this._choose(b, o));
        bank.appendChild(b);
      });
      body.appendChild(bank);
    }
  },

  _r_build(ex, body) {
    body.appendChild(this._prompt('Build the definition of', ex.card.term, ex.card.term));
    const line = this._el('div', 'ls-answer');
    line.id = 'ls-answer';
    const bank = this._el('div', 'ls-bank');
    bank.id = 'ls-bank';
    body.appendChild(line);
    body.appendChild(bank);
    this._drawBuild();
  },

  _drawBuild() {
    const ex = this._ex;
    const line = document.getElementById('ls-answer');
    const bank = document.getElementById('ls-bank');
    if (!line || !bank) return;
    line.innerHTML = ''; bank.innerHTML = '';
    this._built.forEach(id => {
      const c = ex.chips.find(x => x.id === id);
      const b = this._el('button', 'ls-chip', c.text);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (ex.state !== 'ask') return;
        this._built = this._built.filter(x => x !== id);
        this._drawBuild(); this._refresh();
      });
      line.appendChild(b);
    });
    ex.chips.forEach(c => {
      if (this._built.includes(c.id)) return;
      const b = this._el('button', 'ls-chip', c.text);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (ex.state !== 'ask') return;
        this._built.push(c.id);
        this._drawBuild(); this._refresh();
      });
      bank.appendChild(b);
    });
  },

  _r_match(ex, body) {
    ex.matched = 0;
    const grid = this._el('div', 'ls-match');
    const colL = this._el('div', 'ls-col');
    const colR = this._el('div', 'ls-col');
    const mk = (c, side, text) => {
      const b = this._el('button', 'ls-tile', text);
      b.type = 'button';
      b.dataset.id = c.id;
      b.dataset.side = side;
      b.addEventListener('click', () => this._tapTile(b));
      return b;
    };
    ex.left.forEach(c  => colL.appendChild(mk(c, 'l', c.term)));
    ex.right.forEach(c => colR.appendChild(mk(c, 'r', c.definition)));
    grid.appendChild(colL); grid.appendChild(colR);
    body.appendChild(grid);
  },

  _tapTile(btn) {
    const ex = this._ex;
    if (!ex || ex.state !== 'ask' || btn.classList.contains('matched')) return;
    const prev = this._mSel;
    if (!prev || prev.dataset.side === btn.dataset.side) {
      if (prev) prev.classList.remove('selected');
      if (prev === btn) { this._mSel = null; return; }
      this._mSel = btn;
      btn.classList.add('selected');
      return;
    }
    // one from each side
    this._mSel = null;
    prev.classList.remove('selected');
    if (prev.dataset.id === btn.dataset.id) {
      [prev, btn].forEach(b => b.classList.add('matched'));
      DB.Progress.recordCard(this._set.id, btn.dataset.id, true);
      ex.matched++;
      if (ex.matched === ex.pairs.length) {
        ex.failed = ex.mm > 0;       // mistakes cost no hearts here, but cost first-try credit
        this._settle(true, '');
      }
    } else {
      ex.mm++;
      const termTile = prev.dataset.side === 'l' ? prev : btn;
      DB.Progress.recordCard(this._set.id, termTile.dataset.id, false);
      [prev, btn].forEach(b => b.classList.add('shake'));
      setTimeout(() => [prev, btn].forEach(b => b.classList.remove('shake')), 320);
    }
  },

  /* ---------- checking ---------- */

  _isReady() {
    const ex = this._ex;
    if (!ex) return false;
    switch (ex.type) {
      case 'mc_def2term': case 'mc_term2def': case 'listen_pick': return this._sel !== null;
      case 'blank':       return ex.typed ? !!(this._inputEl && this._inputEl.value.trim()) : this._sel !== null;
      case 'type': case 'listen_type': return !!(this._inputEl && this._inputEl.value.trim());
      case 'build':       return this._built.length > 0;
      default:            return false;
    }
  },

  _refresh() {
    const check = document.getElementById('ls-check');
    if (this._ex && this._ex.state === 'ask') check.disabled = !this._isReady();
  },

  _evaluate() {
    const ex = this._ex, c = ex.card;
    switch (ex.type) {
      case 'mc_def2term': case 'listen_pick':
        return { ok: this._sel === c.term, answer: c.term };
      case 'mc_term2def':
        return { ok: this._sel === c.definition, answer: c.definition };
      case 'blank': {
        if (ex.typed) {
          const r = Utils.checkTyped(this._inputEl.value, ex.answer);
          return { ok: r !== 'wrong', close: r === 'close', answer: ex.answer };
        }
        return { ok: this._sel === ex.answer, answer: ex.answer };
      }
      case 'type': case 'listen_type': {
        const r = Utils.checkTyped(this._inputEl.value, c.term);
        return { ok: r !== 'wrong', close: r === 'close', answer: c.term };
      }
      case 'build': {
        const got = this._built.map(id => ex.chips.find(x => x.id === id).text).join(' ');
        return { ok: got === ex.words.join(' '), answer: ex.words.join(' ') };
      }
    }
    return { ok: false, answer: '' };
  },

  // Enter key / Check / Continue all land here
  primary() {
    if (!this._playing || !this._ex) return;
    if (this._ex.state === 'ask') {
      if (this._ex.type === 'match' || !this._isReady()) return;
      const r = this._evaluate();
      this._settle(r.ok, r.answer, r.close);
    } else {
      this._continue();
    }
  },

  dontKnow() {
    if (!this._playing || !this._ex || this._ex.state !== 'ask') return;
    this._settle(false, this._answerText(), false, true);
  },

  _answerText() {
    const ex = this._ex;
    switch (ex.type) {
      case 'mc_term2def': return ex.card.definition;
      case 'blank':       return ex.answer;
      case 'build':       return ex.words.join(' ');
      default:            return ex.card.term;
    }
  },

  _settle(ok, answer, close, gaveUp) {
    const ex = this._ex;
    ex.state = ok ? 'right' : 'wrong';
    const first = !ex.failed;

    // progress + counters
    if (ex.type !== 'match') DB.Progress.recordCard(this._set.id, ex.card.id, ok);
    if (!ex.counted) {
      ex.counted = true;
      this._attempts++;
      if (ok && first) this._firstOk++;
    }
    if (ok) {
      this._xp += first ? 10 : 5;
    } else {
      ex.failed = true;
      this._hearts = Math.max(0, this._hearts - 1);
      this._mistakes++;
      this._missed.set(ex.card.id, ex.card);
    }

    this._paint(ok, answer);

    const praise = ['Nice!', 'Great!', 'Exactly!', 'Correct!', 'Well done!'];
    const msg = document.getElementById('ls-msg');
    if (ok) {
      msg.innerHTML = `<strong>${_esc(praise[Math.floor(Math.random() * praise.length)])}</strong>` +
        (close ? `<span>Mind the spelling: ${_esc(answer)}</span>` : '');
    } else {
      msg.innerHTML = `<strong>${gaveUp ? 'No problem' : 'Not quite'}</strong>` +
        (answer ? `<span>Correct answer: ${_esc(answer)}</span>` : '') +
        `<span class="ls-again">You'll see this one again.</span>`;
    }
    document.getElementById('ls-bar').className = 'ls-bar ' + (ok ? 'right' : 'wrong');
    const check = document.getElementById('ls-check');
    check.classList.remove('hidden');
    check.textContent = 'Continue';
    check.disabled = false;
    document.getElementById('ls-skip').classList.add('hidden');
    this._hud();
  },

  _paint(ok, answer) {
    const ex = this._ex;
    const cls = ok ? 'correct' : 'wrong';
    document.querySelectorAll('#ls-body .ls-opt').forEach(b => {
      b.classList.add('locked');
      if (b.dataset.val === answer) b.classList.add('correct');
      else if (b.classList.contains('selected')) b.classList.add('wrong');
    });
    if (ex.type === 'blank') {
      const g = document.getElementById('ls-gap');
      if (g) { g.textContent = ex.answer; g.className = 'ls-gap filled ' + cls; }
      document.querySelectorAll('#ls-body .ls-chip.pick').forEach(b => {
        b.classList.add('locked');
        if (b.dataset.val === ex.answer) b.classList.add('correct');
        else if (b.classList.contains('selected')) b.classList.add('wrong');
      });
    }
    if (this._inputEl) { this._inputEl.readOnly = true; this._inputEl.classList.add(cls); }
    if (ex.type === 'build') {
      const line = document.getElementById('ls-answer');
      if (line) line.classList.add(cls);
      document.querySelectorAll('#ls-body .ls-chip').forEach(b => b.classList.add('locked'));
    }
  },

  _continue() {
    const ex = this._ex;
    if (ex.state === 'right') {
      this._done++;
      this._queue.shift();
    } else if (ex.state === 'wrong') {
      this._queue.shift();
      if (this._hearts <= 0) { this._finish(false); return; }
      this._queue.push(ex);                 // missed exercises repeat at the end
    } else {
      return;
    }
    if (!this._queue.length) this._finish(true);
    else this._render();
  },

  _finish(passed) {
    this._playing = false;
    Speech.cancel();
    const dur = Date.now() - this._startMs;
    const set = this._set;
    let bonus = 0;
    if (passed && this._mistakes === 0) bonus = 10;
    const earned = this._xp + bonus;
    const total  = DB.Meta.addXp(earned);

    if (this._attempts > 0) DB.Progress.recordSession(set.id, this._firstOk, this._attempts);
    DB.Sessions.log(set.id, 'lesson', this._firstOk, this._attempts, dur);

    document.getElementById('lesson-play').classList.add('hidden');
    const acc = Utils.pct(this._firstOk, this._attempts);
    _renderResult('lesson', {
      title: passed ? 'Lesson complete' : 'Out of hearts',
      sub:   passed
        ? (bonus ? 'A perfect lesson — +10 bonus XP. ' : '') + 'Total XP: ' + total
        : 'Look over these cards, then give it another go.',
      stats: [
        { value: '+' + earned,                cls: 'correct', label: 'XP earned' },
        { value: acc + '%',                    cls: acc >= 70 ? 'correct' : 'wrong', label: 'Right first try' },
        { value: this._hearts + ' / ' + this.HEARTS, cls: this._hearts ? 'neutral' : 'wrong', label: 'Hearts left' },
        { value: Utils.formatDuration(dur),    cls: 'neutral', label: 'Time' },
      ],
      extra:   _missedList(passed ? 'Worth another look' : 'Cards that tripped you up', [...this._missed.values()]),
      actions: [
        { label: passed ? 'Another lesson' : 'Try again', primary: true, onClick: () => this.start() },
        { label: 'Back to flashcards', onClick: () => App.navigate('flashcards') },
      ],
    });
  },

  // number keys 1-4 pick an option
  keySelect(n) {
    if (!this._playing || !this._ex || this._ex.state !== 'ask') return;
    const els = document.querySelectorAll('#ls-body .ls-opt, #ls-body .ls-chip.pick');
    if (els[n - 1]) els[n - 1].click();
  },
};

/* ============================================
   CREATE / EDIT PAGE
   ============================================ */

const CreatePage = {
  _editId: null,
  _rowCount: 0,

  init() {
    this._editId   = null;
    this._rowCount = 0;
    document.getElementById('create-title').textContent   = 'Create Set';
    document.getElementById('edit-set-id').value          = '';
    document.getElementById('new-set-title').value        = '';
    document.getElementById('new-set-subject').value      = 'General';
    document.getElementById('new-set-desc').value         = '';
    document.getElementById('card-rows').innerHTML        = '';

    // Start with 4 blank rows
    this.addRow();
    this.addRow();
    this.addRow();
    this.addRow();
  },

  editSet(id) {
    const set = DB.Sets.get(id);
    if (!set) return;
    // Navigate first: navigate('create') runs init(), which clears the form
    App.navigate('create');
    this._editId   = id;
    this._rowCount = 0;

    document.getElementById('create-title').textContent  = 'Edit Set';
    document.getElementById('edit-set-id').value         = id;
    document.getElementById('new-set-title').value       = set.title;
    document.getElementById('new-set-subject').value     = set.subject;
    document.getElementById('new-set-desc').value        = set.description || '';
    document.getElementById('card-rows').innerHTML       = '';

    set.cards.forEach(c => this.addRow(c));
    if (set.cards.length < 2) this.addRow();
  },

  addRow(card = null) {
    this._rowCount++;
    const n   = this._rowCount;
    const row = document.createElement('div');
    row.className    = 'card-row';
    row.dataset.rowN = n;
    row.innerHTML = `
      <div class="card-row-header">
        <span class="card-row-num">Card ${n}</span>
        <button class="card-row-remove" title="Remove card" onclick="CreatePage.removeRow(this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="card-inputs">
        <textarea class="card-textarea" placeholder="Term" data-field="term">${card ? _esc(card.term) : ''}</textarea>
        <textarea class="card-textarea" placeholder="Definition" data-field="def">${card ? _esc(card.definition) : ''}</textarea>
      </div>
    `;
    if (card?.id) row.dataset.cardId = card.id;
    document.getElementById('card-rows').appendChild(row);
    this._updateCount();
  },

  removeRow(btn) {
    const rows = document.querySelectorAll('#card-rows .card-row');
    if (rows.length <= 1) { Toast.show('A set needs at least one card.'); return; }
    btn.closest('.card-row').remove();
    this._updateCount();
  },

  // Re-label rows 1..n after bulk changes (import)
  renumber() {
    const rows = document.querySelectorAll('#card-rows .card-row');
    rows.forEach((row, i) => {
      row.dataset.rowN = i + 1;
      const label = row.querySelector('.card-row-num');
      if (label) label.textContent = 'Card ' + (i + 1);
    });
    this._rowCount = rows.length;
    this._updateCount();
  },

  _updateCount() {
    const n = document.querySelectorAll('#card-rows .card-row').length;
    document.getElementById('card-count-label').textContent = n + (n === 1 ? ' card' : ' cards');
  },

  _collectCards() {
    const rows = document.querySelectorAll('#card-rows .card-row');
    const cards = [];
    rows.forEach(row => {
      const term = row.querySelector('[data-field="term"]')?.value.trim();
      const def  = row.querySelector('[data-field="def"]')?.value.trim();
      if (term || def) {
        const obj = { term: term || '', definition: def || '' };
        if (row.dataset.cardId) obj.id = row.dataset.cardId;
        cards.push(obj);
      }
    });
    return cards;
  },

  save() {
    const title   = document.getElementById('new-set-title').value.trim();
    const subject = document.getElementById('new-set-subject').value;
    const desc    = document.getElementById('new-set-desc').value.trim();
    const cards   = this._collectCards();

    if (!title) { Toast.show('Please enter a title.', 'error'); return; }
    const valid = cards.filter(c => c.term && c.definition);
    if (valid.length === 0) {
      Toast.show('Add at least one complete card (term and definition).', 'error');
      return;
    }

    const editId = document.getElementById('edit-set-id').value;
    let set;
    if (editId) {
      set = DB.Sets.update(editId, title, subject, desc, valid);
      Toast.show('Set updated.', 'success');
    } else {
      set = DB.Sets.create(title, subject, desc, valid);
      Toast.show('Set created.', 'success');
    }

    App.activeSetId = set.id;
    App.navigate('flashcards');
  },

  cancel() {
    App.navigate(App.activeSetId ? 'sets' : 'home');
  },
};

/* ============================================
   STATS PAGE
   ============================================ */

const StatsPage = {
  init() {
    const sets    = DB.Sets.list();
    const meta    = DB.Meta.get();
    const total   = DB.Sets.totalCards();
    const sessions = DB.Sessions.count();

    document.getElementById('stats-sets').textContent         = sets.length;
    document.getElementById('stats-cards').textContent        = total;
    document.getElementById('stats-sessions').textContent     = sessions;
    document.getElementById('stats-best-streak').textContent  = (meta.bestStreak || 0) + 'd';

    const list = document.getElementById('stats-set-list');
    list.innerHTML = '';
    if (sets.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No data yet. Start studying to track progress.</p></div>';
      return;
    }

    sets.forEach(s => {
      const acc     = DB.Progress.accuracyForSet(s.id);
      const mastery = DB.Progress.masteryForSet(s.id);
      const sCount  = DB.Sessions.forSet(s.id).length;

      const fillClass = acc === null ? 'low' : acc >= 75 ? 'good' : acc >= 50 ? 'mid' : 'low';
      const fillPct   = acc !== null ? acc : 0;

      const row = document.createElement('div');
      row.className = 'stats-set-row';
      row.innerHTML = `
        <div class="stats-set-name">${_esc(s.title)}</div>
        <div class="stats-set-detail">${s.cards.length} cards &bull; ${sCount} sessions &bull; ${mastery}% mastered</div>
        <div class="accuracy-bar-wrap">
          <div class="accuracy-bar">
            <div class="accuracy-fill ${fillClass}" style="width:${fillPct}%"></div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
            ${acc !== null ? acc + '% accuracy' : 'No data'}
          </div>
        </div>
      `;
      list.appendChild(row);
    });
  },
};

/* ============================================
   EXPORT MODAL
   Quizlet-style text export: choose the separator between
   term/definition and between rows, preview, copy or download.
   ============================================ */

const ExportModal = {
  _set: null,

  TERM_SEPS: { tab: '\t', comma: ',' },
  ROW_SEPS:  { newline: '\n', semicolon: ';' },

  open(setId) {
    const set = DB.Sets.get(setId);
    if (!set) { Toast.show('Open a set first.', 'error'); return; }
    this._set = set;

    document.getElementById('export-subtitle').textContent = set.title;
    document.getElementById('export-count').textContent =
      set.cards.length + (set.cards.length === 1 ? ' card' : ' cards');

    // Reset to Quizlet's defaults: tab between term/definition, new line between rows
    this._setRadio('export-term-sep', 'tab');
    this._setRadio('export-row-sep', 'newline');
    document.getElementById('export-term-custom').value = '';
    document.getElementById('export-row-custom').value  = '';

    this.refresh();
    Modal.open('modal-export');
  },

  pickCustom(name) {
    this._setRadio(name, 'custom');
  },

  _setRadio(name, value) {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  },

  // Returns the chosen separator string, or null if "Custom" is picked but empty.
  _readSep(name, customId, map) {
    const choice = document.querySelector(`input[name="${name}"]:checked`).value;
    if (choice === 'custom') {
      // Allow typing \t and \n for tab / newline
      const raw = document.getElementById(customId).value
        .replace(/\\t/g, '\t')
        .replace(/\\n/g, '\n');
      return raw === '' ? null : raw;
    }
    return map[choice];
  },

  _seps() {
    const termSep = this._readSep('export-term-sep', 'export-term-custom', this.TERM_SEPS);
    const rowSep  = this._readSep('export-row-sep',  'export-row-custom',  this.ROW_SEPS);
    if (termSep === null || rowSep === null) return null;
    return { termSep, rowSep };
  },

  // Wrap a field in quotes (CSV-style) only when it would otherwise be ambiguous
  _field(text, termSep, rowSep) {
    const s = String(text ?? '');
    const needsQuotes = s.includes(termSep) || s.includes(rowSep) || /[\r\n]/.test(s);
    return needsQuotes ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  build() {
    if (!this._set) return null;
    const seps = this._seps();
    if (!seps) return null;
    const { termSep, rowSep } = seps;
    return this._set.cards
      .map(c => this._field(c.term, termSep, rowSep) + termSep + this._field(c.definition, termSep, rowSep))
      .join(rowSep);
  },

  refresh() {
    const out = this.build();
    const ok  = out !== null;
    const box = document.getElementById('export-preview');
    box.value       = ok ? out : '';
    box.placeholder = ok ? '' : 'Enter a custom separator to see the preview.';
    document.getElementById('export-copy-btn').disabled     = !ok;
    document.getElementById('export-download-btn').disabled = !ok;
  },

  async copy() {
    const text = this.build();
    if (text === null) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      // Fallback for insecure contexts / older browsers
      const box = document.getElementById('export-preview');
      box.focus();
      box.select();
      try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
      box.setSelectionRange(0, 0);
    }
    if (copied) Toast.show('Copied ' + this._set.cards.length + ' cards to clipboard.', 'success');
    else        Toast.show('Copy failed. Select the preview text and copy it manually.', 'error', 3200);
  },

  download() {
    const text = this.build();
    const seps = this._seps();
    if (text === null || !seps) return;

    // Comma + new line is a real CSV, so save it as one
    const isCsv = seps.termSep === ',' && seps.rowSep === '\n';
    const ext   = isCsv ? 'csv' : 'txt';
    const base  = (this._set.title || 'quizly-set')
      .replace(/[\\/:*?"<>|]+/g, '')
      .trim() || 'quizly-set';

    // BOM lets Excel read non-ASCII characters in a CSV correctly
    const blob = new Blob(
      [(isCsv ? '\uFEFF' : '') + text],
      { type: (isCsv ? 'text/csv' : 'text/plain') + ';charset=utf-8' }
    );
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = base + '.' + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    Toast.show('Downloaded ' + base + '.' + ext, 'success');
  },
};

/* ============================================
   IMPORT MODAL
   Paste (or load) text, choose separators, preview, then load
   the cards into the Create / Edit form. Understands quoted
   fields, so anything Export produces round-trips cleanly.
   ============================================ */

const ImportModal = {
  _cards:    [],
  _fileBase: '',

  TERM_SEPS: { tab: '\t', comma: ',' },
  ROW_SEPS:  { newline: '\n', semicolon: ';' },

  open() {
    document.getElementById('import-text').value        = '';
    document.getElementById('import-file').value        = '';
    document.getElementById('import-term-custom').value = '';
    document.getElementById('import-row-custom').value  = '';
    this._setRadio('import-term-sep', 'auto');
    this._setRadio('import-row-sep',  'newline');
    this._setRadio('import-mode',     'append');
    this._fileBase = '';
    this.refresh();
    Modal.open('modal-import');
    document.getElementById('import-text').focus();
  },

  // From the Study Sets page: go to the create form first, then open the dialog
  openFromSets() {
    App.navigate('create');
    this.open();
  },

  pickCustom(name) { this._setRadio(name, 'custom'); },

  _setRadio(name, value) {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  },

  _checked(name) {
    return document.querySelector(`input[name="${name}"]:checked`).value;
  },

  // Tab wins if present anywhere, otherwise comma, otherwise tab
  detectTermSep(text) {
    if (text.includes('\t')) return { key: 'tab', sep: '\t' };
    if (text.includes(','))  return { key: 'comma', sep: ',' };
    return { key: 'tab', sep: '\t' };
  },

  _readSep(name, customId, map) {
    const choice = this._checked(name);
    if (choice === 'custom') {
      const raw = document.getElementById(customId).value
        .replace(/\\t/g, '\t')
        .replace(/\\n/g, '\n');
      return raw === '' ? null : raw;
    }
    return map[choice];
  },

  /**
   * Split text into cards.
   *  - Fields wrapped in "quotes" may contain separators and line breaks;
   *    "" inside quotes is a literal quote.
   *  - If a row has more than two fields (e.g. an unquoted comma inside a
   *    definition), the first field is the term and the rest is the definition.
   */
  parse(text, termSep, rowSep) {
    text = text.replace(/^\uFEFF/, '');
    if (rowSep === '\n') text = text.replace(/\r\n?/g, '\n');

    const rows = [];
    let row = [], field = '', quoted = false, inQuotes = false, i = 0;
    const endField = () => { row.push(field); field = ''; quoted = false; };
    const endRow   = () => { endField(); rows.push(row); row = []; };

    while (i < text.length) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; }
          else { inQuotes = false; i++; }
        } else { field += ch; i++; }
        continue;
      }
      if (ch === '"' && field === '' && !quoted) { inQuotes = true; quoted = true; i++; continue; }
      if (text.startsWith(termSep, i)) { endField(); i += termSep.length; continue; }
      if (text.startsWith(rowSep, i))  { endRow();   i += rowSep.length;  continue; }
      field += ch; i++;
    }
    endRow();

    const cards = [];
    let skipped = 0;
    rows.forEach(fields => {
      if (fields.every(f => f.trim() === '')) return; // blank line
      const term = fields[0].trim();
      const def  = fields.slice(1).join(termSep).trim();
      if (!term || !def) { skipped++; return; }
      cards.push({ term, definition: def });
    });
    return { cards, skipped };
  },

  refresh() {
    const text   = document.getElementById('import-text').value;
    const status = document.getElementById('import-status');
    const list   = document.getElementById('import-preview-list');
    const btn    = document.getElementById('import-apply-btn');
    const autoEl = document.getElementById('import-auto-label');

    // Auto-detect label
    const auto = this.detectTermSep(text);
    autoEl.textContent = text.trim() ? '(detected: ' + auto.key + ')' : '';

    // Replace warning only matters when editing an existing set
    const editing = !!document.getElementById('edit-set-id').value;
    document.getElementById('import-replace-hint').classList.toggle(
      'hidden', !(editing && this._checked('import-mode') === 'replace'));

    this._cards = [];
    list.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Import';
    status.className = 'import-status';

    if (!text.trim()) { status.textContent = 'Nothing to import yet.'; return; }

    const termSep = this._checked('import-term-sep') === 'auto'
      ? auto.sep
      : this._readSep('import-term-sep', 'import-term-custom', this.TERM_SEPS);
    const rowSep = this._readSep('import-row-sep', 'import-row-custom', this.ROW_SEPS);

    if (termSep === null || rowSep === null) {
      status.className = 'import-status warn';
      status.textContent = 'Enter a custom separator.';
      return;
    }
    if (termSep === rowSep) {
      status.className = 'import-status bad';
      status.textContent = 'The two separators must be different.';
      return;
    }

    const { cards, skipped } = this.parse(text, termSep, rowSep);
    this._cards = cards;

    if (cards.length === 0) {
      status.className = 'import-status bad';
      status.textContent = 'No cards found. Check the separators.' +
        (skipped ? ' (' + skipped + ' row' + (skipped === 1 ? '' : 's') + ' had no definition.)' : '');
      return;
    }

    status.className = 'import-status ' + (skipped ? 'warn' : 'ok');
    status.textContent = cards.length + (cards.length === 1 ? ' card' : ' cards') + ' found' +
      (skipped ? ' — ' + skipped + ' row' + (skipped === 1 ? '' : 's') + ' skipped (missing term or definition)' : '');

    const SHOW = 5;
    cards.slice(0, SHOW).forEach(c => {
      const r = document.createElement('div');
      r.className = 'import-preview-row';
      r.innerHTML = `<span class="import-preview-term">${_esc(c.term)}</span>` +
                    `<span class="import-preview-def">${_esc(c.definition)}</span>`;
      list.appendChild(r);
    });
    if (cards.length > SHOW) {
      const more = document.createElement('div');
      more.className = 'import-preview-more';
      more.textContent = '+ ' + (cards.length - SHOW) + ' more';
      list.appendChild(more);
    }

    btn.disabled = false;
    btn.textContent = 'Import ' + cards.length + (cards.length === 1 ? ' card' : ' cards');
  },

  loadFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      document.getElementById('import-text').value = String(reader.result || '').replace(/^\uFEFF/, '');
      this._fileBase = file.name.replace(/\.[^.]+$/, '');
      this.refresh();
    };
    reader.onerror = () => Toast.show('Could not read that file.', 'error');
    reader.readAsText(file);
  },

  apply() {
    if (!this._cards.length) return;
    const replace = this._checked('import-mode') === 'replace';
    const rowsEl  = document.getElementById('card-rows');

    if (replace) {
      rowsEl.innerHTML = '';
    } else {
      // Drop untouched blank rows so imported cards sit right under existing ones
      rowsEl.querySelectorAll('.card-row').forEach(row => {
        const t = row.querySelector('[data-field="term"]').value.trim();
        const d = row.querySelector('[data-field="def"]').value.trim();
        if (!t && !d) row.remove();
      });
    }

    this._cards.forEach(c => CreatePage.addRow({ term: c.term, definition: c.definition }));
    CreatePage.renumber();

    // Use the file name as the title if the set doesn't have one yet
    const titleEl = document.getElementById('new-set-title');
    if (!titleEl.value.trim() && this._fileBase) titleEl.value = this._fileBase.slice(0, 80);

    const n = this._cards.length;
    Modal.close('modal-import');
    Toast.show('Imported ' + n + (n === 1 ? ' card' : ' cards') + '. Review them, then save the set.', 'success', 3200);
    rowsEl.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
};

/* ============================================
   GLOBAL HELPERS
   ============================================ */

// XSS-safe text insertion helper
function _esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  const openModals = document.querySelectorAll('.modal-overlay:not(.hidden)');
  if (openModals.length) {
    if (e.key === 'Escape') openModals.forEach(m => m.classList.add('hidden'));
    return; // don't trigger study shortcuts behind a modal
  }

  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const page  = App.currentPage;
  const onBtn = tag === 'BUTTON';
  const click = (sel, i) => { const els = document.querySelectorAll(sel); if (els[i]) els[i].click(); };
  const num   = { '1': 0, '2': 1, '3': 2, '4': 3 };

  if (page === 'flashcards' && FlashcardPage.isStudying()) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') FlashcardPage.next();
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   FlashcardPage.prev();
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); FlashcardPage.flip(); }
    if (e.key === '1') FlashcardPage.mark(true);
    if (e.key === '2') FlashcardPage.mark(false);
  }

  if (page === 'learn' && num[e.key] !== undefined) click('#learn-options .quiz-option', num[e.key]);
  if (page === 'quiz'  && num[e.key] !== undefined) click('#quiz-options .quiz-option',  num[e.key]);
  if (page === 'speed' && num[e.key] !== undefined) click('#speed-options .quiz-option', num[e.key]);

  if (page === 'lesson') {
    if (num[e.key] !== undefined) LessonPage.keySelect(num[e.key] + 1);
    if (e.key === 'Enter' && !e.repeat && !e.target.closest('#ls-bar, .ls-speak')) LessonPage.primary();
  }

  if (page === 'write' && e.key === 'Enter' && !onBtn && !e.repeat) WritePage._enter();

  if (page === 'hangman') {
    if (/^[a-z]$/i.test(e.key)) HangmanPage.guess(e.key.toLowerCase());
    if (e.key === 'Enter' && !onBtn && !e.repeat) HangmanPage.next();
  }

  if (page === 'tf') {
    const k = e.key.toLowerCase();
    if (k === 't' || k === '1') TFPage.answer(true);
    if (k === 'f' || k === '2') TFPage.answer(false);
    if (e.key === 'Enter' && !onBtn && !e.repeat) TFPage.next();
  }
});

/* ============================================
   BOOT
   ============================================ */
document.addEventListener('DOMContentLoaded', () => App.init());
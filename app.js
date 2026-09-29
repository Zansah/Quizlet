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
};

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
      case 'create':     CreatePage.init();     break;
      case 'stats':      StatsPage.init();      break;
    }
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
   ============================================ */

const FlashcardPage = {
  _cards:    [],
  _index:    0,
  _flipped:  false,
  _correct:  0,
  _wrong:    0,
  _setId:    null,
  _startMs:  0,

  init() {
    const setId = App.activeSetId;
    if (!setId) { App.navigate('sets'); return; }
    const set = DB.Sets.get(setId);
    if (!set || set.cards.length === 0) { App.navigate('sets'); return; }

    this._setId   = setId;
    this._cards   = [...set.cards];
    this._index   = 0;
    this._flipped = false;
    this._correct = 0;
    this._wrong   = 0;
    this._startMs = Date.now();

    document.getElementById('fc-title').textContent = set.title;
    document.getElementById('fc-set-meta').textContent =
      set.subject + ' — ' + set.cards.length + ' cards';

    DB.Meta.recordStudyDay();
    this._render();
  },

  _render() {
    const card = this._cards[this._index];
    document.getElementById('fc-term-text').textContent = card.term;
    document.getElementById('fc-def-text').textContent  = card.definition;
    document.getElementById('fc-inner').classList.remove('flipped');
    this._flipped = false;

    const total = this._cards.length;
    const pct   = Math.round(((this._index + 1) / total) * 100);
    document.getElementById('fc-progress-fill').style.width = pct + '%';
    document.getElementById('fc-progress-text').textContent =
      (this._index + 1) + ' / ' + total;

    document.getElementById('fc-stat-correct').textContent = this._correct + ' correct';
    document.getElementById('fc-stat-wrong').textContent   = this._wrong + ' learning';
  },

  flip() {
    this._flipped = !this._flipped;
    document.getElementById('fc-inner').classList.toggle('flipped', this._flipped);
  },

  next() {
    if (this._index < this._cards.length - 1) {
      this._index++;
      this._render();
    }
  },

  prev() {
    if (this._index > 0) {
      this._index--;
      this._render();
    }
  },

  mark(knew) {
    const card = this._cards[this._index];
    if (knew) this._correct++; else this._wrong++;
    DB.Progress.recordCard(this._setId, card.id, knew);

    if (this._index < this._cards.length - 1) {
      this._index++;
      this._render();
    } else {
      this._finish();
    }
  },

  shuffle() {
    this._cards = Utils.shuffle(this._cards);
    this._index = 0;
    this._render();
    Toast.show('Cards shuffled.');
  },

  restart() {
    this._index   = 0;
    this._correct = 0;
    this._wrong   = 0;
    this._startMs = Date.now();
    this._render();
  },

  _finish() {
    const dur = Date.now() - this._startMs;
    DB.Progress.recordSession(this._setId, this._correct, this._cards.length);
    DB.Sessions.log(this._setId, 'flashcards', this._correct, this._cards.length, dur);
    const pct = Utils.pct(this._correct, this._cards.length);
    Toast.show(
      Utils.grade(pct) + ' — ' + this._correct + '/' + this._cards.length + ' correct (' + pct + '%)',
      pct >= 70 ? 'success' : '',
      3000
    );
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
      tiles.push({ id: 'term-' + i,  pairId: 'def-' + i,  text: c.term,       type: 'term' });
      tiles.push({ id: 'def-'  + i,  pairId: 'term-' + i, text: c.definition, type: 'def'  });
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

    App.navigate('create');
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
  const openModal = document.querySelector('.modal-overlay:not(.hidden)');
  if (openModal) {
    if (e.key === 'Escape') openModal.classList.add('hidden');
    return; // don't trigger study shortcuts behind a modal
  }

  const page = App.currentPage;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (page === 'flashcards') {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') FlashcardPage.next();
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   FlashcardPage.prev();
    if (e.key === ' ' || e.key === 'Enter')               FlashcardPage.flip();
    if (e.key === '1') FlashcardPage.mark(true);
    if (e.key === '2') FlashcardPage.mark(false);
  }

  if (page === 'learn' || page === 'quiz') {
    const keys = { '1': 0, '2': 1, '3': 2, '4': 3 };
    if (keys[e.key] !== undefined) {
      const opts = document.querySelectorAll(
        page === 'learn' ? '#learn-options .quiz-option' : '#quiz-options .quiz-option'
      );
      if (opts[keys[e.key]]) opts[keys[e.key]].click();
    }
  }
});

/* ============================================
   BOOT
   ============================================ */
document.addEventListener('DOMContentLoaded', () => App.init());
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, switchMap } from 'rxjs';
import { Movie, MovieExternalIds, MovieService } from '../services/movie.service';

interface WrongGuess {
  guess: string;
  year?: string;
}

interface SeenMovie {
  movieId: number;
  expiry: number;
}

type StripEffect = '' | 'rotate180' | 'grayscale' | 'blackout';

@Component({
  selector: 'app-poster-game',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './poster-game.component.html',
  styleUrl: './poster-game.component.css'
})
export class PosterGameComponent implements OnInit {
  private movieService = inject(MovieService);

  // Tab State
  activeTab = signal<'daily' | 'hard' | 'infinite' | 'infinite-hard'>('daily');
  mediaMode = signal<'movie' | 'tv'>('movie');

  // State
  movie = signal<Movie | null>(null);
  currentStepIndex = signal(0);
  userGuess = signal('');
  gameStatus = signal<'loading' | 'playing' | 'won' | 'lost'>('loading');
  suggestions = signal<Movie[]>([]);
  wrongGuesses = signal<WrongGuess[]>([]);
  showGiveUpConfirm = signal(false);
  showLeaveConfirm = signal(false);
  pendingTab = signal<'daily' | 'hard' | 'infinite' | 'infinite-hard' | null>(null);
  pendingMediaMode = signal<'movie' | 'tv' | null>(null);
  showClearCacheConfirm = signal(false);
  selectedMovieFromAutocomplete = signal<Movie | null>(null);
  dailyCompleted = signal(false);
  dailyCompletedDate = signal('');
  imdbUrl = signal('');
  showApiKeyPrompt = signal(false);
  apiKeyInput = signal('');
  apiKeyError = signal('');

  // Settings
  showSettings = signal(false);
  infiniteMemoryEnabled = signal(true);
  infiniteCountryFilter = signal<'all' | 'fr_en'>('all');

  // Infinite Mode Streaks
  currentStreak = signal(0);
  todayBestStreak = signal(0);
  allTimeBestStreak = signal(0);

  // Hard Mode Strip Effects (assigned per strip)
  stripEffects = signal<StripEffect[]>([]);

  private searchTerms = new Subject<string>();
  private initialized = false;

  // Progression Config
  readonly progressionSteps = [100, 75, 50, 25, 10];

  // LocalStorage Keys
  private readonly LS_DAILY_PREFIX = 'dailyGameWon_';
  private readonly LS_DAILY_HARD_PREFIX = 'dailyHardGameWon_';
  private readonly LS_DAILY_LOST_PREFIX = 'dailyGameLost_';
  private readonly LS_DAILY_HARD_LOST_PREFIX = 'dailyHardGameLost_';
  private readonly LS_SEEN_RANDOM = 'seenRandomMovies';
  private readonly LS_SEEN_RANDOM_TV = 'seenRandomTvShows';
  private readonly LS_INFINITE_MEMORY = 'infiniteMemoryEnabled';
  private readonly LS_INFINITE_COUNTRY_FILTER = 'infiniteCountryFilter';
  private readonly LS_TMDB_TOKEN = 'tmdbToken';
  private readonly LS_MEDIA_MODE = 'mediaMode';
  private readonly LS_CURRENT_STREAK = 'infiniteCurrentStreak';
  private readonly LS_TODAY_BEST_PREFIX = 'infiniteTodayBest_';
  private readonly LS_ALL_TIME_BEST = 'infiniteAllTimeBest';
  private readonly LS_CURRENT_STREAK_HARD = 'infiniteHardCurrentStreak';
  private readonly LS_TODAY_BEST_HARD_PREFIX = 'infiniteHardTodayBest_';
  private readonly LS_ALL_TIME_BEST_HARD = 'infiniteHardAllTimeBest';
  private readonly LS_CURRENT_STREAK_TV = 'infiniteCurrentStreakTv';
  private readonly LS_TODAY_BEST_PREFIX_TV = 'infiniteTodayBestTv_';
  private readonly LS_ALL_TIME_BEST_TV = 'infiniteAllTimeBestTv';
  private readonly LS_CURRENT_STREAK_HARD_TV = 'infiniteHardCurrentStreakTv';
  private readonly LS_TODAY_BEST_HARD_PREFIX_TV = 'infiniteHardTodayBestTv_';
  private readonly LS_ALL_TIME_BEST_HARD_TV = 'infiniteHardAllTimeBestTv';

  private getStreakStorageKeys(mode: 'infinite' | 'infinite-hard') {
    const isTv = this.mediaMode() === 'tv';
    if (mode === 'infinite') {
      return {
        currentKey: isTv ? this.LS_CURRENT_STREAK_TV : this.LS_CURRENT_STREAK,
        todayKey: isTv ? this.LS_TODAY_BEST_PREFIX_TV : this.LS_TODAY_BEST_PREFIX,
        allTimeKey: isTv ? this.LS_ALL_TIME_BEST_TV : this.LS_ALL_TIME_BEST
      };
    }
    return {
      currentKey: isTv ? this.LS_CURRENT_STREAK_HARD_TV : this.LS_CURRENT_STREAK_HARD,
      todayKey: isTv ? this.LS_TODAY_BEST_HARD_PREFIX_TV : this.LS_TODAY_BEST_HARD_PREFIX,
      allTimeKey: isTv ? this.LS_ALL_TIME_BEST_HARD_TV : this.LS_ALL_TIME_BEST_HARD
    };
  }

  ngOnInit() {
    const savedMode = localStorage.getItem(this.LS_MEDIA_MODE);
    if (savedMode === 'tv') {
      this.mediaMode.set('tv');
    }

    // Load settings
    this.infiniteMemoryEnabled.set(localStorage.getItem(this.LS_INFINITE_MEMORY) !== 'false');
    const savedCountryFilter = localStorage.getItem(this.LS_INFINITE_COUNTRY_FILTER);
    if (savedCountryFilter === 'fr_en') {
      this.infiniteCountryFilter.set('fr_en');
    }

    // Load streak data (default to infinite)
    this.loadStreakData('infinite');

    const token = localStorage.getItem(this.LS_TMDB_TOKEN);
    if (!token) {
      this.showApiKeyPrompt.set(true);
      return;
    }

    this.initializeWithToken();
  }

  private initializeWithToken() {
    if (this.initialized) return;
    this.initialized = true;

    // Check if daily game already completed (default tab: daily)
    const active = this.activeTab();
    if (active === 'daily' || active === 'hard') {
      this.syncDailyOutcome(active);
    }
    this.loadForCurrentTab();

    // Setup autocomplete
    this.searchTerms.pipe(
      debounceTime(300),
      distinctUntilChanged(),
      switchMap((term: string) => this.mediaMode() === 'tv'
        ? this.movieService.searchTvShows(term)
        : this.movieService.searchMovies(term)),
    ).subscribe(movies => {
      this.suggestions.set(movies);
    });
  }

  private loadForCurrentTab() {
    const tab = this.activeTab();
    if (tab === 'infinite' || tab === 'infinite-hard') {
      this.loadStreakData(tab);
      this.loadInfiniteMovie();
      return;
    }

    const isTv = this.mediaMode() === 'tv';
    const movieObservable = tab === 'daily'
      ? (isTv ? this.movieService.getDailyTvShow() : this.movieService.getDailyMovie())
      : (isTv ? this.movieService.getDailyTvShowHard() : this.movieService.getDailyMovieHard());

    movieObservable.subscribe({
      next: (movie) => {
        this.movie.set(movie);
        this.imdbUrl.set('');
        if (this.dailyCompleted()) {
          this.gameStatus.set('won');
          this.fetchImdbLink();
        } else if (this.gameStatus() === 'lost') {
          this.showGiveUpConfirm.set(false);
          this.fetchImdbLink();
        } else {
          this.gameStatus.set('playing');
          if (tab === 'hard') {
            this.generateStripEffects();
          }
        }
        this.wrongGuesses.set([]);
        this.showGiveUpConfirm.set(false);
        console.log(`${tab} ${isTv ? 'TV' : 'Movie'}:`, movie.title);
      },
      error: (err) => {
        console.error('Failed to load media', err);
      }
    });
  }

  private loadStreakData(mode: 'infinite' | 'infinite-hard') {
    const today = this.getTodayKey();
    const keys = this.getStreakStorageKeys(mode);
    const currentKey = keys.currentKey;
    const todayKey = keys.todayKey;
    const allTimeKey = keys.allTimeKey;
    this.currentStreak.set(parseInt(localStorage.getItem(currentKey) || '0', 10));
    this.todayBestStreak.set(parseInt(localStorage.getItem(todayKey + today) || '0', 10));
    this.allTimeBestStreak.set(parseInt(localStorage.getItem(allTimeKey) || '0', 10));
  }

  private saveStreakData(mode: 'infinite' | 'infinite-hard') {
    const today = this.getTodayKey();
    const keys = this.getStreakStorageKeys(mode);
    const currentKey = keys.currentKey;
    const todayKey = keys.todayKey;
    const allTimeKey = keys.allTimeKey;
    localStorage.setItem(currentKey, this.currentStreak().toString());
    localStorage.setItem(todayKey + today, this.todayBestStreak().toString());
    localStorage.setItem(allTimeKey, this.allTimeBestStreak().toString());
  }

  private getTodayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  private formatDateForDisplay(key: string): string {
    const day = key.substring(6, 8);
    const month = key.substring(4, 6);
    const year = key.substring(2, 4);
    return `${day}/${month}/${year}`;
  }

  setMediaMode(mode: 'movie' | 'tv') {
    if (this.mediaMode() === mode) return;
    if (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') {
      this.pendingMediaMode.set(mode);
      this.showLeaveConfirm.set(true);
      return;
    }
    this.mediaMode.set(mode);
    localStorage.setItem(this.LS_MEDIA_MODE, mode);
    this.switchTab(this.activeTab(), true);
  }

  toggleSettings() {
    this.showSettings.update(v => !v);
  }

  toggleInfiniteMemory() {
    this.infiniteMemoryEnabled.update(v => !v);
    localStorage.setItem(this.LS_INFINITE_MEMORY, this.infiniteMemoryEnabled().toString());
  }

  setInfiniteCountryFilter(value: string) {
    const next = value === 'fr_en' ? 'fr_en' : 'all';
    this.infiniteCountryFilter.set(next);
    localStorage.setItem(this.LS_INFINITE_COUNTRY_FILTER, next);
  }

  submitApiKey() {
    const token = this.apiKeyInput().trim();
    if (!token) {
      this.apiKeyError.set('Veuillez coller une clé API valide.');
      return;
    }
    this.apiKeyError.set('');
    this.movieService.validateToken(token).subscribe(ok => {
      if (!ok) {
        this.apiKeyError.set('Clé invalide ou refusée par TMDB.');
        return;
      }
      localStorage.setItem(this.LS_TMDB_TOKEN, token);
      this.showApiKeyPrompt.set(false);
      this.apiKeyInput.set('');
      this.apiKeyError.set('');
      this.initializeWithToken();
    });
  }

  requestTabSwitch(tab: 'daily' | 'hard' | 'infinite' | 'infinite-hard') {
    if (this.activeTab() === tab) return;
    const isInfiniteTab = this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard';
    if (isInfiniteTab) {
      this.pendingTab.set(tab);
      this.showLeaveConfirm.set(true);
      return;
    }
    this.switchTab(tab);
  }

  confirmLeaveTab() {
    if (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') {
      const mode = this.activeTab() === 'infinite-hard' ? 'infinite-hard' : 'infinite';
      this.currentStreak.set(0);
      this.saveStreakData(mode);
    }
    const pendingMode = this.pendingMediaMode();
    if (pendingMode) {
      this.mediaMode.set(pendingMode);
      localStorage.setItem(this.LS_MEDIA_MODE, pendingMode);
      this.pendingMediaMode.set(null);
      this.showLeaveConfirm.set(false);
      this.switchTab(this.activeTab(), true);
      return;
    }

    const target = this.pendingTab();
    if (!target) return;
    this.showLeaveConfirm.set(false);
    this.pendingTab.set(null);
    this.switchTab(target);
  }

  cancelLeaveTab() {
    this.showLeaveConfirm.set(false);
    this.pendingTab.set(null);
    this.pendingMediaMode.set(null);
  }

  private switchTab(tab: 'daily' | 'hard' | 'infinite' | 'infinite-hard', force = false) {
    if (!force && this.activeTab() === tab) return;

    if (this.activeTab() !== tab) {
      this.activeTab.set(tab);
    }
    this.gameStatus.set('loading');
    this.currentStepIndex.set(0);
    this.userGuess.set('');
    this.wrongGuesses.set([]);
    this.showGiveUpConfirm.set(false);
    this.selectedMovieFromAutocomplete.set(null);
    this.dailyCompleted.set(false);
    this.stripEffects.set([]);

    if (tab === 'infinite' || tab === 'infinite-hard') {
      this.loadStreakData(tab);
      this.loadInfiniteMovie();
    } else {
      this.syncDailyOutcome(tab);

      const isTv = this.mediaMode() === 'tv';
      const movieObservable = tab === 'daily'
        ? (isTv ? this.movieService.getDailyTvShow() : this.movieService.getDailyMovie())
        : (isTv ? this.movieService.getDailyTvShowHard() : this.movieService.getDailyMovieHard());

      movieObservable.subscribe({
        next: (movie) => {
          this.movie.set(movie);
          this.imdbUrl.set('');
          if (this.dailyCompleted()) {
            this.gameStatus.set('won');
            this.fetchImdbLink();
          } else if (this.gameStatus() === 'lost') {
            // Keep loss state if already recorded for today
            this.showGiveUpConfirm.set(false);
            this.fetchImdbLink();
          } else {
            this.gameStatus.set('playing');
            if (tab === 'hard') {
              this.generateStripEffects();
            }
          }
          console.log(`${tab} Movie:`, movie.title);
        },
        error: (err) => {
          console.error('Failed to load movie', err);
        }
      });
    }
  }

  private loadInfiniteMovie() {
    this.gameStatus.set('loading');
    this.currentStepIndex.set(0);
    this.userGuess.set('');
    this.wrongGuesses.set([]);
    this.showGiveUpConfirm.set(false);
    this.selectedMovieFromAutocomplete.set(null);
    this.stripEffects.set([]);

    const seenIds = this.infiniteMemoryEnabled()
      ? this.getSeenRandomMovies().map(s => s.movieId)
      : [];

    const isTv = this.mediaMode() === 'tv';
    const random$ = isTv
      ? this.movieService.getRandomTvShow(seenIds, this.infiniteCountryFilter())
      : this.movieService.getRandomMovie(seenIds, this.infiniteCountryFilter());

    random$.subscribe({
      next: (movie) => {
        this.movie.set(movie);
        this.imdbUrl.set('');
        this.gameStatus.set('playing');
        if (this.activeTab() === 'infinite-hard') {
          this.generateStripEffects();
        }
        console.log('Infinite Movie:', movie.title);
      },
      error: (err) => {
        console.error('Failed to load infinite movie', err);
        this.gameStatus.set('lost');
      }
    });
  }

  private generateStripEffects() {
    const count = this.currentStripCount(); // Match current step strip count
    const effects: StripEffect[] = [];
    const possibleEffects: StripEffect[] = ['', 'rotate180', 'grayscale', 'blackout'];

    for (let i = 0; i < count; i++) {
      // ~30% chance for each effect type, weighted towards 'none'
      const rand = Math.random();
      if (rand < 0.4) {
        effects.push('');
      } else if (rand < 0.6) {
        effects.push('rotate180');
      } else if (rand < 0.8) {
        effects.push('grayscale');
      } else {
        effects.push('blackout');
      }
    }
    this.stripEffects.set(effects);
  }

  getStripEffect(index: number): StripEffect {
    const effects = this.stripEffects();
    if (this.activeTab() !== 'hard' && this.activeTab() !== 'infinite-hard') return '';
    if (effects.length === 0) return '';
    return effects[index] || '';
  }

  onInput(term: string) {
    this.userGuess.set(term);
    this.selectedMovieFromAutocomplete.set(null);
    this.searchTerms.next(term);
  }

  selectSuggestion(movie: Movie) {
    const year = movie.release_date?.substring(0, 4);
    this.userGuess.set(year ? `${movie.title} (${year})` : movie.title);
    this.selectedMovieFromAutocomplete.set(movie);
    this.suggestions.set([]);
  }

  private getSeenRandomKey(): string {
    return this.mediaMode() === 'tv' ? this.LS_SEEN_RANDOM_TV : this.LS_SEEN_RANDOM;
  }

  private getSeenRandomMovies(): SeenMovie[] {
    try {
      const stored = localStorage.getItem(this.getSeenRandomKey());
      if (!stored) return [];
      const parsed: SeenMovie[] = JSON.parse(stored);
      const now = Date.now();
      return parsed.filter(s => s.expiry > now);
    } catch {
      return [];
    }
  }

  private addSeenRandomMovie(movieId: number) {
    const seen = this.getSeenRandomMovies();
    const expiry = Date.now() + 2 * 24 * 60 * 60 * 1000;
    seen.push({ movieId, expiry });
    localStorage.setItem(this.getSeenRandomKey(), JSON.stringify(seen));
  }

  giveUp() {
    this.showGiveUpConfirm.set(true);
  }

  confirmGiveUp() {
    this.gameStatus.set('lost');
    this.showGiveUpConfirm.set(false);
    this.markCurrentMovieSeen();
    this.fetchImdbLink();

    // Reset streak on give up in infinite mode
    if (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') {
      const mode = this.activeTab() === 'infinite-hard' ? 'infinite-hard' : 'infinite';
      this.currentStreak.set(0);
      this.saveStreakData(mode);
    } else {
      const tab = this.activeTab();
      if (tab === 'daily' || tab === 'hard') {
        this.markDailyLoss(tab);
      }
    }
  }

  cancelGiveUp() {
    this.showGiveUpConfirm.set(false);
  }

  private markCurrentMovieSeen() {
    const m = this.movie();
    if (m && (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') && this.infiniteMemoryEnabled()) {
      this.addSeenRandomMovie(m.id);
    }
  }

  // Computed
  isRandomDisabled = computed(() => {
    const status = this.gameStatus();
    if (status === 'loading') return true;
    if (status === 'playing' && this.currentStepIndex() > 0) return true;
    return false;
  });

  currentStripCount = computed(() => this.progressionSteps[this.currentStepIndex()]);
  mediaInputPlaceholder = computed(() => this.mediaMode() === 'tv' ? 'Nom de la série...' : 'Nom du film...');
  mediaHintText = computed(() => this.mediaMode() === 'tv' ? '(Devinez le titre exact de la série !)' : '(Devinez le titre exact du film !)');
  mediaResultLabel = computed(() => this.mediaMode() === 'tv' ? 'La série était :' : 'Le film était :');
  mediaTypeLabel = computed(() => this.mediaMode() === 'tv' ? 'séries' : 'films');
  mediaNextLabel = computed(() => this.mediaMode() === 'tv' ? 'Série Suivante →' : 'Film Suivant →');
  remainingAttempts = computed(() => Math.max(0, this.progressionSteps.length - this.currentStepIndex()));

  hardRotateCount = computed(() => this.stripEffects().filter(e => e === 'rotate180').length);
  hardGrayscaleCount = computed(() => this.stripEffects().filter(e => e === 'grayscale').length);
  hardBlackoutCount = computed(() => this.stripEffects().filter(e => e === 'blackout').length);

  imageUrl = computed(() => {
    const m = this.movie();
    return m ? this.movieService.getImageUrl(m.poster_path) : '';
  });

  releaseYear = computed(() => {
    const m = this.movie();
    return m?.release_date ? m.release_date.substring(0, 4) : '';
  });

  shuffledStrips = computed(() => {
    const count = this.currentStripCount();
    const indices = Array.from({ length: count }, (_, i) => i);
    return this.shuffleArray(indices);
  });

  validateGuess() {
    if (this.gameStatus() !== 'playing') return;

    const rawGuess = this.userGuess();
    const selectedMovie = this.selectedMovieFromAutocomplete();
    const targetMovie = this.movie();

    // Si vide, c'est un SKIP
    if (!rawGuess.trim()) {
      this.wrongGuesses.update(prev => [...prev, { guess: 'SKIPPED' }]);
      this.nextStep();
      return;
    }

    let isCorrect = false;

    const { title: guessTitle, year: guessYear } = this.extractGuess(rawGuess);
    const targetTitle = targetMovie?.title || '';
    const targetOriginalTitle = (targetMovie as any)?.original_title || (targetMovie as any)?.original_name || '';
    const targetYear = targetMovie?.release_date?.substring(0, 4) || '';
    const guessYearMatches = !guessYear || !targetYear || guessYear === targetYear;

    if (selectedMovie && targetMovie) {
      const selectedYear = selectedMovie.release_date?.substring(0, 4) || '';

      if (selectedMovie.id === targetMovie.id) {
        isCorrect = true;
      } else if (!selectedYear || !targetYear || selectedYear === targetYear) {
        const selectedTitle = this.normalizeTitle(selectedMovie.title, false);
        const selectedTitleNoArticle = this.normalizeTitle(selectedMovie.title, true);
        const targetTitleNorm = this.normalizeTitle(targetTitle, false);
        const targetTitleNoArticle = this.normalizeTitle(targetTitle, true);

        if (selectedTitle === targetTitleNorm || selectedTitleNoArticle === targetTitleNoArticle) {
          isCorrect = true;
        }
      }
    } else {
      const guessNorm = this.normalizeTitle(guessTitle, false);
      const guessNoArticle = this.normalizeTitle(guessTitle, true);
      const targetNorm = this.normalizeTitle(targetTitle, false);
      const targetNoArticle = this.normalizeTitle(targetTitle, true);
      const originalNorm = this.normalizeTitle(targetOriginalTitle, false);
      const originalNoArticle = this.normalizeTitle(targetOriginalTitle, true);

      if (guessYearMatches && (
        guessNorm === targetNorm ||
        (originalNorm && guessNorm === originalNorm) ||
        guessNoArticle === targetNoArticle ||
        (originalNoArticle && guessNoArticle === originalNoArticle) ||
        guessNorm === 'win'
      )) {
        isCorrect = true;
      }
    }

    if (isCorrect) {
      this.gameStatus.set('won');
      this.markCurrentMovieSeen();
      this.fetchImdbLink();

      if (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') {
        const mode = this.activeTab() === 'infinite-hard' ? 'infinite-hard' : 'infinite';
        // Increment streak
        this.currentStreak.update(s => s + 1);
        const newStreak = this.currentStreak();
        if (newStreak > this.todayBestStreak()) {
          this.todayBestStreak.set(newStreak);
        }
        if (newStreak > this.allTimeBestStreak()) {
          this.allTimeBestStreak.set(newStreak);
        }
        this.saveStreakData(mode);
      } else {
        // Save daily win
        const tab = this.activeTab();
        if (tab === 'daily' || tab === 'hard') {
          this.markDailyWin(tab);
        }
      }
    } else {
      const year = selectedMovie?.release_date?.substring(0, 4) || guessYear || '';
      const guessLabel = guessTitle.trim() ? guessTitle : rawGuess;
      this.wrongGuesses.update(prev => [...prev, { guess: guessLabel, year }]);
      this.nextStep();
    }

    this.userGuess.set('');
    this.selectedMovieFromAutocomplete.set(null);
  }

  private getDailyStoragePrefix(tab: 'daily' | 'hard', type: 'win' | 'loss'): string {
    const base = tab === 'daily'
      ? (type === 'win' ? this.LS_DAILY_PREFIX : this.LS_DAILY_LOST_PREFIX)
      : (type === 'win' ? this.LS_DAILY_HARD_PREFIX : this.LS_DAILY_HARD_LOST_PREFIX);
    const suffix = this.mediaMode() === 'tv' ? 'tv' : 'movie';
    return `${base}${suffix}_`;
  }

  private markDailyWin(tab: 'daily' | 'hard') {
    const today = this.getTodayKey();
    const lsKey = this.getDailyStoragePrefix(tab, 'win');
    const lsLostKey = this.getDailyStoragePrefix(tab, 'loss');
    localStorage.setItem(lsKey + today, 'true');
    localStorage.removeItem(lsLostKey + today);
    this.dailyCompleted.set(true);
    this.dailyCompletedDate.set(this.formatDateForDisplay(today));
  }

  private markDailyLoss(tab: 'daily' | 'hard') {
    const today = this.getTodayKey();
    const lsKey = this.getDailyStoragePrefix(tab, 'loss');
    const lsWinKey = this.getDailyStoragePrefix(tab, 'win');
    localStorage.setItem(lsKey + today, 'true');
    localStorage.removeItem(lsWinKey + today);
  }

  private syncDailyOutcome(tab: 'daily' | 'hard') {
    const today = this.getTodayKey();
    const lsWinKey = this.getDailyStoragePrefix(tab, 'win');
    const lsLostKey = this.getDailyStoragePrefix(tab, 'loss');
    const dailyWon = localStorage.getItem(lsWinKey + today);
    const dailyLost = localStorage.getItem(lsLostKey + today);

    this.dailyCompleted.set(false);
    if (dailyWon === 'true') {
      this.dailyCompleted.set(true);
      this.dailyCompletedDate.set(this.formatDateForDisplay(today));
      this.gameStatus.set('won');
    } else if (dailyLost === 'true') {
      this.dailyCompletedDate.set(this.formatDateForDisplay(today));
      this.gameStatus.set('lost');
    }
  }

  loadNextInfiniteMovie() {
    this.loadInfiniteMovie();
  }

  private extractGuess(raw: string): { title: string; year: string } {
    const yearMatch = raw.match(/(19|20)\d{2}/);
    const year = yearMatch ? yearMatch[0] : '';
    let title = raw;
    if (year) {
      title = title.replace(year, '');
    }
    title = title.replace(/[()]/g, '').trim();
    return { title, year };
  }

  private stripLeadingArticles(str: string): string {
    const trimmed = str.trim().toLowerCase();
    const withoutElision = trimmed.replace(/^l['`]/, '');
    return withoutElision.replace(/^(the|a|an|le|la|les|un|une|des|el|los|las|il|lo|gli|i)\s+/, '').trim();
  }

  private normalizeTitle(str: string, dropArticles: boolean): string {
    const base = dropArticles ? this.stripLeadingArticles(str) : str;
    return base.toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  nextStep() {
    if (this.currentStepIndex() < this.progressionSteps.length - 1) {
      this.currentStepIndex.update(i => i + 1);
      if ((this.activeTab() === 'hard' || this.activeTab() === 'infinite-hard') && this.gameStatus() === 'playing') {
        this.generateStripEffects();
      }
    } else {
      this.gameStatus.set('lost');
      this.markCurrentMovieSeen();
      this.fetchImdbLink();

      // Reset streak on loss in infinite mode
      if (this.activeTab() === 'infinite' || this.activeTab() === 'infinite-hard') {
        const mode = this.activeTab() === 'infinite-hard' ? 'infinite-hard' : 'infinite';
        this.currentStreak.set(0);
        this.saveStreakData(mode);
      } else {
        const tab = this.activeTab();
        if (tab === 'daily' || tab === 'hard') {
          this.markDailyLoss(tab);
        }
      }
    }
  }

  clearCache() {
    localStorage.clear();
    window.location.reload();
  }

  private fetchImdbLink() {
    const m = this.movie();
    if (!m) return;
    const isTv = this.mediaMode() === 'tv';
    const ids$ = isTv ? this.movieService.getTvExternalIds(m.id) : this.movieService.getMovieExternalIds(m.id);

    ids$.subscribe({
      next: (ids: MovieExternalIds) => {
        this.imdbUrl.set(ids.imdb_id ? `https://www.imdb.com/title/${ids.imdb_id}/` : '');
      },
      error: () => {
        this.imdbUrl.set('');
      }
    });
  }

  requestClearCache() {
    this.showClearCacheConfirm.set(true);
  }

  cancelClearCache() {
    this.showClearCacheConfirm.set(false);
  }

  private shuffleArray(array: number[]): number[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

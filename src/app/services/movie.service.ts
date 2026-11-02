import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';

export interface Movie {
  id: number;
  title: string;
  poster_path: string;
  overview: string;
  release_date: string;
  original_language?: string;
  original_title?: string;
}

export interface MovieExternalIds {
  id: number;
  imdb_id: string | null;
}

interface DailyPool {
  start: number;
  size: number;
  key: number;
}

interface TvShow {
  id: number;
  name: string;
  poster_path: string;
  overview: string;
  first_air_date: string;
  original_language?: string;
  original_name?: string;
}


@Injectable({
  providedIn: 'root'
})
export class MovieService {
  private http = inject(HttpClient);
  private readonly apiUrl = 'https://api.themoviedb.org/3';
  private readonly LS_TMDB_TOKEN = 'tmdbToken';
  private readonly LS_DAILY_MOVIE_PREFIX = 'dailyMovieId_';
  private readonly LS_DAILY_HARD_MOVIE_PREFIX = 'dailyHardMovieId_';
  private readonly LS_DAILY_TV_PREFIX = 'dailyTvShowId_';
  private readonly LS_DAILY_HARD_TV_PREFIX = 'dailyHardTvShowId_';


  getDailyMovie(): Observable<Movie> {
    return this.getDailyMovieInternal(this.DAILY_POOLS.movie, this.LS_DAILY_MOVIE_PREFIX);
  }

  getDailyMovieHard(): Observable<Movie> {
    return this.getDailyMovieInternal(this.DAILY_POOLS.movieHard, this.LS_DAILY_HARD_MOVIE_PREFIX);
  }

  getDailyTvShow(): Observable<Movie> {
    return this.getDailyTvInternal(this.DAILY_POOLS.tv, this.LS_DAILY_TV_PREFIX);
  }

  getDailyTvShowHard(): Observable<Movie> {
    return this.getDailyTvInternal(this.DAILY_POOLS.tvHard, this.LS_DAILY_HARD_TV_PREFIX);
  }

  private getDailyMovieInternal(pool: DailyPool, storagePrefix: string): Observable<Movie> {
    const todayKey = this.getTodayKey();
    const storedId = localStorage.getItem(storagePrefix + todayKey);

    if (storedId) {
      const id = parseInt(storedId, 10);
      if (!Number.isNaN(id)) {
        return this.getMovieById(id).pipe(
          catchError(() => this.pickAndStoreDailyMovie(pool, storagePrefix, todayKey))
        );
      }
    }

    return this.pickAndStoreDailyMovie(pool, storagePrefix, todayKey);
  }

  private getDailyTvInternal(pool: DailyPool, storagePrefix: string): Observable<Movie> {
    const todayKey = this.getTodayKey();
    const storedId = localStorage.getItem(storagePrefix + todayKey);

    if (storedId) {
      const id = parseInt(storedId, 10);
      if (!Number.isNaN(id)) {
        return this.getTvShowById(id).pipe(
          catchError(() => this.pickAndStoreDailyTvShow(pool, storagePrefix, todayKey))
        );
      }
    }

    return this.pickAndStoreDailyTvShow(pool, storagePrefix, todayKey);
  }

  /**
   * Sélection du jour sans répétition.
   *
   * On pioche dans un classement stable (discover trié par nombre de votes,
   * langue originale FR ou EN uniquement) plutôt que dans /popular, qui bouge
   * tous les jours et ne contient que l'actualité.
   *
   * Chaque mode utilise une tranche de ce classement : rangs [start, start + size).
   * Le jour N donne le rang start + permute(N mod size), où permute est un
   * mélange bijectif (Feistel) : aucun rang ne revient avant `size` jours,
   * l'ordre paraît aléatoire, et tout le monde a le même titre le même jour.
   */
  private readonly DAILY_POOLS: Record<'movie' | 'movieHard' | 'tv' | 'tvHard', DailyPool> = {
    movie:     { start: 0,   size: 600,  key: 0x1f2e3d4c }, // films très connus
    movieHard: { start: 600, size: 1000, key: 0x5a6b7c8d }, // films connus mais moins évidents
    tv:        { start: 0,   size: 300,  key: 0x13579bdf }, // séries très connues
    tvHard:    { start: 300, size: 500,  key: 0x2468ace0 }, // séries moins évidentes
  };

  private readonly FR_EN_LANGUAGES = 'fr|en';
  // Pas de JT, téléréalité, talk-shows ni feuilletons quotidiens pour les séries
  private readonly TV_EXCLUDED_GENRES = '10763|10764|10766|10767';

  private dailyRank(pool: DailyPool): number {
    const d = new Date();
    const dayNumber = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
    return pool.start + this.permute(dayNumber % pool.size, pool.size, pool.key);
  }

  /** Bijection de [0, size) dans lui-même (réseau de Feistel + cycle walking). */
  private permute(x: number, size: number, key: number): number {
    const halfBits = Math.ceil(Math.ceil(Math.log2(Math.max(size, 2))) / 2);
    const mask = (1 << halfBits) - 1;
    let value = x;
    do {
      let left = value >>> halfBits;
      let right = value & mask;
      for (let round = 0; round < 4; round++) {
        const f = this.mix(right ^ Math.imul(key, round + 1)) & mask;
        [left, right] = [right, left ^ f];
      }
      value = (left << halfBits) | right;
    } while (value >= size);
    return value;
  }

  private mix(n: number): number {
    let h = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) >>> 0;
  }

  private pickAndStoreDailyMovie(pool: DailyPool, storagePrefix: string, todayKey: string): Observable<Movie> {
    const rank = this.dailyRank(pool);
    const page = Math.floor(rank / 20) + 1;

    return this.getDiscoverPage('movie', page).pipe(
      map(results => this.pickAtIndex(results as Movie[], rank % 20)),
      map(picked => {
        if (!picked) {
          throw new Error('No movies available for daily selection');
        }
        localStorage.setItem(storagePrefix + todayKey, String(picked.id));
        return picked;
      })
    );
  }

  private pickAndStoreDailyTvShow(pool: DailyPool, storagePrefix: string, todayKey: string): Observable<Movie> {
    const rank = this.dailyRank(pool);
    const page = Math.floor(rank / 20) + 1;

    return this.getDiscoverPage('tv', page).pipe(
      map(results => this.pickAtIndex(results as TvShow[], rank % 20)),
      map(picked => {
        if (!picked) {
          throw new Error('No TV shows available for daily selection');
        }
        localStorage.setItem(storagePrefix + todayKey, String(picked.id));
        return this.mapTvToMovie(picked);
      })
    );
  }

  /** Élément à l'index voulu ; s'il n'a pas d'affiche, le suivant qui en a une. */
  private pickAtIndex<T extends { id: number; poster_path: string }>(items: T[], index: number): T | undefined {
    for (let i = 0; i < items.length; i++) {
      const item = items[(index + i) % items.length];
      if (item?.poster_path) return item;
    }
    return undefined;
  }

  private discoverPageCache = new Map<string, Observable<unknown[]>>();

  /** Page du classement stable : langue originale FR/EN, triée par nombre de votes. */
  private getDiscoverPage(kind: 'movie' | 'tv', page: number): Observable<unknown[]> {
    const key = `${kind}-${page}`;
    const cached = this.discoverPageCache.get(key);
    if (cached) return cached;

    const params = [
      'language=fr-FR',
      'include_adult=false',
      'sort_by=vote_count.desc',
      `with_original_language=${encodeURIComponent(this.FR_EN_LANGUAGES)}`,
      `page=${page}`,
    ];
    if (kind === 'tv') {
      params.push(`without_genres=${encodeURIComponent(this.TV_EXCLUDED_GENRES)}`);
    }

    const request$ = this.http
      .get<any>(`${this.apiUrl}/discover/${kind}?${params.join('&')}`, { headers: this.getAuthHeaders() })
      .pipe(map(response => response.results as unknown[]), shareReplay(1));

    this.discoverPageCache.set(key, request$);
    return request$;
  }

  /**
   * Liste du mode infini : /popular sans filtre, ou discover trié par popularité
   * restreint aux titres en langue originale FR/EN (filtré côté TMDB, donc fiable).
   */
  private randomListUrl(kind: 'movie' | 'tv', page: number, languageFilter: 'all' | 'fr_en'): string {
    if (languageFilter !== 'fr_en') {
      return `${this.apiUrl}/${kind}/popular?language=fr-FR&page=${page}`;
    }
    const params = [
      'language=fr-FR',
      'include_adult=false',
      'sort_by=popularity.desc',
      'vote_count.gte=200',
      `with_original_language=${encodeURIComponent(this.FR_EN_LANGUAGES)}`,
      `page=${page}`,
    ];
    if (kind === 'tv') {
      params.push(`without_genres=${encodeURIComponent(this.TV_EXCLUDED_GENRES)}`);
    }
    return `${this.apiUrl}/discover/${kind}?${params.join('&')}`;
  }

  getRandomMovie(excludeIds: number[] = [], languageFilter: 'all' | 'fr_en' = 'all'): Observable<Movie> {
    // Choisir une page au hasard pour avoir de la variété (1 à 50)
    const randomPage = Math.floor(Math.random() * 50) + 1;
    const headers = this.getAuthHeaders();

    return this.http.get<any>(this.randomListUrl('movie', randomPage, languageFilter), { headers }).pipe(
      map(response => {
        const source = (response.results as Movie[]).filter(m => m.poster_path);
        let movies = source;
        // Filter out already seen movies
        if (excludeIds.length > 0) {
          movies = movies.filter(m => !excludeIds.includes(m.id));
        }
        // If all movies on this page are excluded, just pick from all (fallback)
        if (movies.length === 0) {
          movies = source;
        }
        const index = Math.floor(Math.random() * movies.length);
        const picked = movies[index];

        if (languageFilter === 'fr_en' && picked) {
          const lang = picked.original_language;
          if (lang !== 'fr' && lang !== 'en') {
            const fallback = movies.find(m => m.original_language === 'fr' || m.original_language === 'en');
            return fallback || picked;
          }
        }

        return picked;
      })
    );
  }


  getRandomTvShow(excludeIds: number[] = [], languageFilter: 'all' | 'fr_en' = 'all'): Observable<Movie> {
    const randomPage = Math.floor(Math.random() * 50) + 1;
    const headers = this.getAuthHeaders();

    return this.http.get<any>(this.randomListUrl('tv', randomPage, languageFilter), { headers }).pipe(
      map(response => {
        const source = (response.results as TvShow[]).filter(s => s.poster_path).map(s => this.mapTvToMovie(s));
        let shows = source;
        if (excludeIds.length > 0) {
          shows = shows.filter(s => !excludeIds.includes(s.id));
        }
        if (shows.length === 0) {
          shows = source;
        }
        const index = Math.floor(Math.random() * shows.length);
        const picked = shows[index];

        if (languageFilter === 'fr_en' && picked) {
          const lang = picked.original_language;
          if (lang !== 'fr' && lang !== 'en') {
            const fallback = shows.find(s => s.original_language === 'fr' || s.original_language === 'en');
            return fallback || picked;
          }
        }

        return picked;
      })
    );
  }

  getMovieExternalIds(id: number): Observable<MovieExternalIds> {
    const headers = this.getAuthHeaders();

    return this.http.get<MovieExternalIds>(`${this.apiUrl}/movie/${id}/external_ids`, { headers });
  }

  getTvExternalIds(id: number): Observable<MovieExternalIds> {
    const headers = this.getAuthHeaders();
    return this.http.get<MovieExternalIds>(`${this.apiUrl}/tv/${id}/external_ids`, { headers });
  }

  getMovieById(id: number): Observable<Movie> {
    const headers = this.getAuthHeaders();
    return this.http.get<Movie>(`${this.apiUrl}/movie/${id}?language=fr-FR`, { headers });
  }

  getTvShowById(id: number): Observable<Movie> {
    const headers = this.getAuthHeaders();
    return this.http.get<TvShow>(`${this.apiUrl}/tv/${id}?language=fr-FR`, { headers }).pipe(
      map(show => this.mapTvToMovie(show))
    );
  }

  searchMovies(query: string): Observable<Movie[]> {
    if (!query || query.length < 2) return new Observable(obs => obs.next([]));

    const headers = this.getAuthHeaders();

    return this.http.get<any>(`${this.apiUrl}/search/movie?language=fr-FR&query=${encodeURIComponent(query)}&page=1`, { headers }).pipe(
      map(response => response.results.slice(0, 5) as Movie[]) // Limit to 5 suggestions
    );
  }

  searchTvShows(query: string): Observable<Movie[]> {
    if (!query || query.length < 2) return new Observable(obs => obs.next([]));

    const headers = this.getAuthHeaders();

    return this.http.get<any>(`${this.apiUrl}/search/tv?language=fr-FR&query=${encodeURIComponent(query)}&page=1`, { headers }).pipe(
      map(response => (response.results as TvShow[]).slice(0, 5).map(show => this.mapTvToMovie(show)))
    );
  }

  validateToken(token: string): Observable<boolean> {
    const headers = this.getAuthHeaders(token);
    return this.http.get<any>(`${this.apiUrl}/movie/popular?language=fr-FR&page=1`, { headers }).pipe(
      map(() => true),
      catchError(() => of(false))
    );
  }

  private getAuthHeaders(tokenOverride?: string): HttpHeaders {
    const token = (tokenOverride ?? localStorage.getItem(this.LS_TMDB_TOKEN) ?? '').trim();
    return token ? new HttpHeaders({ Authorization: `Bearer ${token}` }) : new HttpHeaders();
  }

  private getTodayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  getImageUrl(path: string): string {
    return `https://image.tmdb.org/t/p/original${path}`;
  }

  private mapTvToMovie(show: TvShow): Movie {
    return {
      id: show.id,
      title: show.name,
      poster_path: show.poster_path,
      overview: show.overview,
      release_date: show.first_air_date,
      original_language: show.original_language,
      original_title: show.original_name ?? show.name
    };
  }
}

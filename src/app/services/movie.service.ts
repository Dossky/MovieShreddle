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

  // Cache pour ne pas spammer l'API à chaque reload pendant le dev
  // Dans un vrai daily, on pourrait stocker le film du jour en localStorage
  private moviesCache$: Observable<Movie[]> | null = null;
  private moviesPageCache = new Map<number, Observable<Movie[]>>();
  private tvPageCache = new Map<number, Observable<Movie[]>>();

  getDailyMovie(): Observable<Movie> {
    return this.getDailyMovieInternal(0, this.LS_DAILY_MOVIE_PREFIX);
  }

  getDailyMovieHard(): Observable<Movie> {
    return this.getDailyMovieInternal(12345, this.LS_DAILY_HARD_MOVIE_PREFIX);
  }

  getDailyTvShow(): Observable<Movie> {
    return this.getDailyTvInternal(0, this.LS_DAILY_TV_PREFIX);
  }

  getDailyTvShowHard(): Observable<Movie> {
    return this.getDailyTvInternal(12345, this.LS_DAILY_HARD_TV_PREFIX);
  }

  private getDailyMovieInternal(seedOffset: number, storagePrefix: string): Observable<Movie> {
    const todayKey = this.getTodayKey();
    const storedId = localStorage.getItem(storagePrefix + todayKey);

    if (storedId) {
      const id = parseInt(storedId, 10);
      if (!Number.isNaN(id)) {
        return this.getMovieById(id).pipe(
          catchError(() => this.pickAndStoreDailyMovie(seedOffset, storagePrefix, todayKey))
        );
      }
    }

    return this.pickAndStoreDailyMovie(seedOffset, storagePrefix, todayKey);
  }

  private getDailyTvInternal(seedOffset: number, storagePrefix: string): Observable<Movie> {
    const todayKey = this.getTodayKey();
    const storedId = localStorage.getItem(storagePrefix + todayKey);

    if (storedId) {
      const id = parseInt(storedId, 10);
      if (!Number.isNaN(id)) {
        return this.getTvShowById(id).pipe(
          catchError(() => this.pickAndStoreDailyTvShow(seedOffset, storagePrefix, todayKey))
        );
      }
    }

    return this.pickAndStoreDailyTvShow(seedOffset, storagePrefix, todayKey);
  }

  private pickAndStoreDailyMovie(seedOffset: number, storagePrefix: string, todayKey: string): Observable<Movie> {
    const today = new Date();
    const seedBase = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate() + seedOffset;
    const page = (this.pseudoRandom(seedBase + 9999) % 50) + 1;

    return this.getPopularMoviesPage(page).pipe(
      map(movies => {
        if (!movies.length) {
          throw new Error('No movies available for daily selection');
        }
        const index = this.pseudoRandom(seedBase) % movies.length;
        const picked = movies[index];
        if (picked?.id) {
          localStorage.setItem(storagePrefix + todayKey, String(picked.id));
        }
        return picked;
      })
    );
  }


  private pickAndStoreDailyTvShow(seedOffset: number, storagePrefix: string, todayKey: string): Observable<Movie> {
    const today = new Date();
    const seedBase = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate() + seedOffset;
    const page = (this.pseudoRandom(seedBase + 9999) % 50) + 1;

    return this.getPopularTvPage(page).pipe(
      map(shows => {
        if (!shows.length) {
          throw new Error('No TV shows available for daily selection');
        }
        const index = this.pseudoRandom(seedBase) % shows.length;
        const picked = shows[index];
        if (picked?.id) {
          localStorage.setItem(storagePrefix + todayKey, String(picked.id));
        }
        return picked;
      })
    );
  }

  private getPopularMovies(): Observable<Movie[]> {
    return this.getPopularMoviesPage(1);
  }

  private getPopularMoviesPage(page: number): Observable<Movie[]> {
    const cached = this.moviesPageCache.get(page);
    if (cached) return cached;

    const headers = this.getAuthHeaders();
    const request$ = this.http.get<any>(`${this.apiUrl}/movie/popular?language=fr-FR&page=${page}`, { headers }).pipe(
      map(response => {
        const results = response.results as Movie[];
        return results.filter(m => m.poster_path); // Filter out movies without poster
      }),
      shareReplay(1)
    );

    this.moviesPageCache.set(page, request$);
    return request$;
  }

  private getPopularTvPage(page: number): Observable<Movie[]> {
    const cached = this.tvPageCache.get(page);
    if (cached) return cached;

    const headers = this.getAuthHeaders();
    const request$ = this.http.get<any>(`${this.apiUrl}/tv/popular?language=fr-FR&page=${page}`, { headers }).pipe(
      map(response => {
        const results = response.results as TvShow[];
        return results.filter(s => s.poster_path).map(show => this.mapTvToMovie(show));
      }),
      shareReplay(1)
    );

    this.tvPageCache.set(page, request$);
    return request$;
  }

  getRandomMovie(excludeIds: number[] = [], languageFilter: 'all' | 'fr_en' = 'all'): Observable<Movie> {
    // Choisir une page au hasard pour avoir de la variété (1 à 50)
    const randomPage = Math.floor(Math.random() * 50) + 1;
    const headers = this.getAuthHeaders();

    return this.http.get<any>(`${this.apiUrl}/movie/popular?language=fr-FR&page=${randomPage}`, { headers }).pipe(
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

    return this.http.get<any>(`${this.apiUrl}/tv/popular?language=fr-FR&page=${randomPage}`, { headers }).pipe(
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

  // Générateur pseudo-aléatoire simple pour avoir le même résultat pour une graine donnée
  private pseudoRandom(seed: number): number {
    const x = Math.sin(seed) * 10000;
    return Math.floor((x - Math.floor(x)) * 1000000); // Entier
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

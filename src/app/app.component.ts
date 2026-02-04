import { Component } from '@angular/core';
import { PosterGameComponent } from './poster-game/poster-game.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [PosterGameComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent {
  title = 'MovieShreddle';
}

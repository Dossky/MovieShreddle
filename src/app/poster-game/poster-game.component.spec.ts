import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PosterGameComponent } from './poster-game.component';

describe('PosterGameComponent', () => {
  let component: PosterGameComponent;
  let fixture: ComponentFixture<PosterGameComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PosterGameComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PosterGameComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

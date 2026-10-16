import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { Auth } from './auth';
import { authGuard } from './auth.guard';

function runGuard(session: unknown) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: Auth, useValue: { ready: Promise.resolve(), session: signal(session) } },
    ],
  });
  return TestBed.runInInjectionContext(() => authGuard({} as never, {} as never));
}

describe('authGuard', () => {
  it('senza sessione rimanda alla pagina di accesso', async () => {
    const result = (await runGuard(null)) as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(result)).toBe('/accesso');
  });

  it('con una sessione lascia passare', async () => {
    expect(await runGuard({ user: {} })).toBe(true);
  });
});

import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Auth } from '../../core/auth';

@Component({
  selector: 'app-login',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <main class="login">
      <h1>Bilancio</h1>
      @if (!codeSent()) {
        <form (ngSubmit)="send()">
          <mat-form-field appearance="outline">
            <mat-label>Email</mat-label>
            <input matInput type="email" name="email" autocomplete="email" required [(ngModel)]="email" />
          </mat-form-field>
          <button mat-flat-button type="submit" [disabled]="busy() || !email">Invia codice</button>
        </form>
      } @else {
        <form (ngSubmit)="verify()">
          <p>Abbiamo inviato un codice a {{ email }}.</p>
          <mat-form-field appearance="outline">
            <mat-label>Codice</mat-label>
            <input
              matInput
              name="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="10"
              required
              [(ngModel)]="code"
            />
          </mat-form-field>
          <button mat-flat-button type="submit" [disabled]="busy() || code.length < 6">Accedi</button>
          <button mat-button type="button" (click)="codeSent.set(false)">Cambia email</button>
        </form>
      }
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </main>
  `,
  styles: `
    .login {
      display: grid;
      gap: 16px;
      max-width: 360px;
      margin: 0 auto;
      padding: calc(48px + env(safe-area-inset-top)) 16px 16px;
    }
    form {
      display: grid;
      gap: 8px;
    }
    button {
      min-height: 44px;
    }
    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class Login {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  email = '';
  code = '';
  readonly codeSent = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  send(): Promise<void> {
    return this.run('Invio non riuscito: controlla l’email o riprova tra poco.', async () => {
      await this.auth.sendCode(this.email.trim());
      this.codeSent.set(true);
    });
  }

  verify(): Promise<void> {
    return this.run('Codice non valido o scaduto.', async () => {
      await this.auth.verifyCode(this.email.trim(), this.code.trim());
      await this.router.navigateByUrl('/');
    });
  }

  private async run(message: string, action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch {
      this.error.set(message);
    } finally {
      this.busy.set(false);
    }
  }
}

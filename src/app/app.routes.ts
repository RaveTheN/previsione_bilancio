import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: 'accesso', loadComponent: () => import('./features/auth/login').then((m) => m.Login) },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: 'mese', loadComponent: () => import('./features/month/month').then((m) => m.Month) },
      {
        path: 'movimenti',
        loadComponent: () => import('./features/transactions/transactions').then((m) => m.Transactions),
      },
      { path: 'altro', loadComponent: () => import('./features/settings/settings').then((m) => m.Settings) },
      { path: '', pathMatch: 'full', redirectTo: 'mese' },
    ],
  },
  { path: '**', redirectTo: '' },
];

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { applyTheme } from './app/core/theme';

// Prima dell'avvio, così la pagina non lampeggia con l'altro tema.
applyTheme();

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

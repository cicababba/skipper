// About dialog dictionary — EN is the master shape; other languages must
// mirror its keys exactly.

const en = {
  tagline: "Your AI-powered second brain",
  close: "Close",
  createdBy: "Created by Mike Gazzaruso",
  rights: "© 2026 NextEpochs. All rights reserved.",
};

const it: typeof en = {
  tagline: "Il tuo secondo cervello potenziato dall'IA",
  close: "Chiudi",
  createdBy: "Creato da Mike Gazzaruso",
  rights: "© 2026 NextEpochs. Tutti i diritti riservati.",
};

const fr: typeof en = {
  tagline: "Votre second cerveau propulsé par l'IA",
  close: "Fermer",
  createdBy: "Créé par Mike Gazzaruso",
  rights: "© 2026 NextEpochs. Tous droits réservés.",
};

const es: typeof en = {
  tagline: "Tu segundo cerebro impulsado por IA",
  close: "Cerrar",
  createdBy: "Creado por Mike Gazzaruso",
  rights: "© 2026 NextEpochs. Todos los derechos reservados.",
};

export const about = { en, it, fr, es };

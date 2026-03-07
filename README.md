# Backend - AF-WIN | Le Chiffre Gagnant

Ce répertoire contient le backend de l'application AF-WIN, une plateforme de jeu basée sur le concept du "chiffre le moins misé".

## 🚀 Technologies utilisées

- **Runtime**: [Node.js](https://nodejs.org/)
- **Langage**: [TypeScript](https://www.typescriptlang.org/)
- **Framework**: [Express.js](https://expressjs.com/)
- **Base de données**: [Firebase Firestore](https://firebase.google.com/docs/firestore)
- **Authentification**: [Clerk](https://clerk.com/)
- **Tâches planifiées**: [Node-cron](https://www.npmjs.com/package/node-cron)
- **Notifications**: [Nodemailer](https://nodemailer.com/)

---

## 📂 Structure du projet

```text
backend/
├── src/
│   ├── config/         # Configuration Firebase et autres
│   ├── controllers/    # Logique métier des endpoints
│   ├── jobs/           # Tâches planifiées (scheduler de tirage)
│   ├── middleware/     # Authentification, Maintenance, Rate limiting
│   ├── routes/         # Définition des routes de l'API
│   ├── types/          # Interfaces et types TypeScript
│   ├── utils/          # Utilitaires (parsing SMS, email, etc.)
│   └── index.ts        # Point d'entrée du serveur
├── .env                # Variables d'environnement
└── package.json        # Dépendances et scripts
```

---

## ⚙️ Installation et Configuration

### 1. Variables d'environnement
Créez un fichier `.env` basé sur `.env.example` :
```env
PORT=3000
CLERK_SECRET_KEY=sk_test_...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="..."
SMTP_HOST=...
SMTP_USER=...
SMTP_PASS=...
```

### 2. Scripts Disponibles
```bash
# Installer les dépendances
npm install

# Lancer en mode développement (auto-reload)
npm run dev

# Compiler en JavaScript
npm run build

# Lancer en mode production
npm start
```

---

## 🛠️ API Reference

### 1. Draws (Tirages)
- `GET /api/draws/current` : Récupère le tirage du jour (en crée un si inexistant).
- `GET /api/draws/history` : Historique des tirages passés.

### 2. Bets (Paris)
- `POST /api/bets` : Place un nouveau pari sur le tirage en cours.
  - *Note: Limité à 1 pari par 24h par utilisateur.*
- `GET /api/bets/my-bets` : Historique des paris de l'utilisateur.

### 3. Wallet (Portefeuille)
- `GET /api/wallet/balance` : Solde actuel de l'utilisateur.
- `POST /api/wallet/deposit` : Soumet un contenu SMS pour parsing et dépôt automatique.
- `POST /api/wallet/withdraw` : Demande de retrait.
- `GET /api/wallet/transactions` : Historique des transactions.
- `GET /api/wallet/networks` : Liste des réseaux de paiement actifs.

### 4. Admin
- `POST /api/admin/resolve-draw` : Clôture manuellement un tirage.
- `GET /api/admin/draw-stats/:draw_id` : Statistiques détaillées des mises par chiffre.
- `POST /api/admin/transactions/review` : Approuve ou rejette une transaction.
- `POST /api/admin/maintenance` : Active/Désactive le mode maintenance.
- `POST /api/admin/settings` : Met à jour les multiplicateurs et limites de mise.
- `GET /api/admin/users` : Liste et gestion des utilisateurs.

---

## 🧠 Logique Métier Clé

### Résolution des Tirages (Multiplicateur Fixe)
À la clôture d'un tirage (18h00), le système calcule automatiquement le total des mises par chiffre.
Le chiffre gagnant est celui ayant reçu **le plus petit montant total de mises**. 
Les utilisateurs ayant parié sur ce chiffre remportent leur mise multipliée par le **multiplicateur global** défini par l'administrateur (ex: x5).

### Parsing des SMS
Le système utilise des Regex complexes (`src/utils/smsParser.ts`) pour extraire automatiquement le montant et l'identifiant de transaction des SMS de paiement (T-Money, Flooz, etc.).

### Règle des 24h
Pour garantir l'équité, un utilisateur ne peut placer qu'un seul pari par période de 24h. Cette vérification est faite dans `src/controllers/bet.controller.ts`.

### Mode Maintenance
Le mode maintenance peut être activé par un admin pour bloquer temporairement les paris et les transactions. Les routes publiques comme l'historique restent accessibles.

### Scheduler (Cron)
Un job tourne automatiquement pour :
- Assurer qu'un nouveau tirage est créé chaque jour à minuit.
- (Optionnel) Effectuer des tirages automatiques à heures fixes.

---

## 🔒 Sécurité
- **Authentification**: Gérée par Clerk via JWT.
- **Rôles**: Certains endpoints sont protégés par le middleware `requireAdmin`.
- **Rate Limiting**: Limites strictes sur les dépôts et les paris pour éviter les abus.

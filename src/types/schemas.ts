import { z } from 'zod';

// Validates a single entry in a multi-number bet
export const BetEntrySchema = z.object({
  number: z.number().int().min(1).max(9, "Le chiffre doit être entre 1 et 9"),
  amount: z.number()
    .positive("Le montant doit être positif")
    .min(100, "Mise minimum 100 CFA par chiffre")
    .max(50000, "Mise maximum 50000 CFA par chiffre"),
});

// Validates a full multi-number bet submission
export const BetSchema = z.object({
  draw_id: z.string().nonempty("ID du tirage obligatoire"),
  entries: z
    .array(BetEntrySchema)
    .min(1, "Au moins un chiffre doit être sélectionné")
    .max(9, "Vous ne pouvez pas parier sur plus de 9 chiffres")
    .refine(
      (entries) => new Set(entries.map(e => e.number)).size === entries.length,
      { message: "Les chiffres sélectionnés doivent être uniques" }
    ),
});

export const DrawIdSchema = z.object({
  draw_id: z.string().nonempty(),
});

export const ResolveDrawSchema = z.object({
  draw_id: z.string().nonempty(),
  winning_number: z.number().int().min(1).max(9),
});

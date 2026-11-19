-- =====================================================================
-- Starting products. Run AFTER schema.sql. Prices are in paise.
-- All products are "made to order" (track_stock = false), so there is no
-- stock limit. Turn on stock tracking per product in Admin > Products.
-- =====================================================================

insert into products (slug, name, description, category, price_paise, sort_order) values
 ('crochet-claw-hair-clip',      'Crochet Claw Hair Clip',      'A claw hair clip with a handmade crochet flower and leaves on top.',                'Hair Clips',        12000, 1),
 ('crochet-clutcher',            'Crochet Clutcher',            'A small clutcher with a handmade crochet flower. Easy to use every day.',           'Hair Clips',        10000, 2),
 ('crochet-flower-bun-stick',    'Crochet Flower Bun Stick',    'A wooden bun stick with a handmade crochet flower ring.',                           'Bun Sticks',        15000, 3),
 ('crochet-hair-scrunchie',      'Crochet Hair Scrunchie',      'A frilly crochet scrunchie. Holds your hair without pulling.',                      'Scrunchies & Ties', 12000, 4),
 ('crochet-alligator-hair-clip', 'Crochet Alligator Hair Clip', 'A pair of alligator clips covered in handmade crochet petals.',                    'Hair Clips',         6000, 5),
 ('crochet-tiktok-hair-clip',    'Crochet TikTok Hair Clip',    'A pair of snap clips with a small crochet flower and a pearl bead.',                'Hair Clips',         5000, 6),
 ('crochet-flower-hair-tie',     'Crochet Flower Hair Tie',     'A bright crochet flower on a hair tie. Cheerful and easy to wear.',                 'Scrunchies & Ties',  5000, 7),
 ('crochet-keychain',            'Crochet Keychain',            'A swirl crochet keychain with a small bead. Good for keys, bags and gifting.',      'Keychains',          5000, 8)
on conflict (slug) do nothing;

-- Colour options (only these two products have colour choices at the moment)
insert into product_variants (product_id, label, sort_order)
select p.id, v.label, v.ord
from products p
join (values
  ('crochet-flower-bun-stick', 'Peach', 1), ('crochet-flower-bun-stick', 'Cream', 2), ('crochet-flower-bun-stick', 'Sky Blue', 3),
  ('crochet-hair-scrunchie',   'Cream', 1), ('crochet-hair-scrunchie',   'Pink',  2), ('crochet-hair-scrunchie',   'Brown',    3), ('crochet-hair-scrunchie', 'Green', 4)
) as v(slug, label, ord) on v.slug = p.slug
on conflict (product_id, label) do nothing;

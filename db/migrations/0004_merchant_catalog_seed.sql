-- 0004: seed rows for the demo merchant catalog.
--
-- Milestone 002, Increment 1. These rows mirror the code fixture
-- src/lib/catalog/merchant-catalog.ts (DEMO_MERCHANT_CATALOG, revision 1).
-- Equality with the fixture is verified by tests (PGT-84 and a static check),
-- not by any CHECK constraint: no constraint names a revision number.
-- No BEGIN or COMMIT: the runner owns the transaction.
-- NEVER EXECUTED: written under Gate B-W.

INSERT INTO shopaccess.merchants (id, display_name, is_simulated_sandbox) VALUES
  ('dmm_shopaccessdemo', 'ShopAccess Demo Store (simulated)', true);

INSERT INTO shopaccess.merchant_products (id, merchant_id, title, description, image_path, catalog_revision) VALUES
  ('dmp_studybook14', 'dmm_shopaccessdemo', 'StudyBook 14',
   'A light 14-inch laptop for notes, documents, browsing and video calls.',
   '/catalog/studybook-14.svg', 1),
  ('dmp_codebook15', 'dmm_shopaccessdemo', 'CodeBook 15',
   'A 15-inch laptop with extra memory and storage for programming coursework.',
   '/catalog/codebook-15.svg', 1),
  ('dmp_valuebook11', 'dmm_shopaccessdemo', 'ValueBook 11',
   'A compact, low-cost laptop for web browsing and light document work.',
   '/catalog/valuebook-11.svg', 1),
  ('dmp_campusbook16', 'dmm_shopaccessdemo', 'CampusBook 16',
   'A large-screen laptop for schoolwork and multitasking at a desk.',
   '/catalog/campusbook-16.svg', 1);

INSERT INTO shopaccess.merchant_variants
  (id, product_id, label, unit_amount_cents, currency, max_quantity_per_order, availability, specs, catalog_revision)
VALUES
  ('dmv_studybook14a', 'dmp_studybook14', '8 GB memory, 256 GB SSD', 44900, 'USD', 2, 'IN_STOCK',
   '{"cpu":"4-core mobile processor","ramGb":8,"storageGb":256,"storageType":"SSD","screenInches":14,"weightKg":1.4,"operatingSystem":"Windows 11 Home"}'::jsonb, 1),
  ('dmv_codebook15a', 'dmp_codebook15', '16 GB memory, 512 GB SSD', 79900, 'USD', 2, 'IN_STOCK',
   '{"cpu":"8-core mobile processor","ramGb":16,"storageGb":512,"storageType":"SSD","screenInches":15.6,"weightKg":1.8,"operatingSystem":"Windows 11 Home"}'::jsonb, 1),
  ('dmv_codebook15b', 'dmp_codebook15', '32 GB memory, 1 TB SSD', 109900, 'USD', 1, 'IN_STOCK',
   '{"cpu":"8-core mobile processor","ramGb":32,"storageGb":1024,"storageType":"SSD","screenInches":15.6,"weightKg":1.8,"operatingSystem":"Windows 11 Home"}'::jsonb, 1),
  ('dmv_valuebook11a', 'dmp_valuebook11', '4 GB memory, 64 GB eMMC', 22900, 'USD', 2, 'IN_STOCK',
   '{"cpu":"2-core entry processor","ramGb":4,"storageGb":64,"storageType":"EMMC","screenInches":11.6,"weightKg":1.1,"operatingSystem":"ChromeOS"}'::jsonb, 1),
  ('dmv_campusbook16a', 'dmp_campusbook16', '16 GB memory, 512 GB SSD', 64900, 'USD', 2, 'OUT_OF_STOCK',
   '{"cpu":"6-core mobile processor","ramGb":16,"storageGb":512,"storageType":"SSD","screenInches":16,"weightKg":2.2,"operatingSystem":"Windows 11 Home"}'::jsonb, 1);

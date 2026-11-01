-- Callers may order in English, so stores and menus need names a caller can hear and say in English.
alter table public.stores add column name_en text;
alter table public.menu_items add column name_en text;

update public.stores set name_en = 'Happy Soup House' where id = '33333333-3333-4333-8333-333333333331';
update public.stores set name_en = 'Great Wall' where id = '33333333-3333-4333-8333-333333333332';
update public.stores set name_en = 'Neighborhood Mart' where id = '33333333-3333-4333-8333-333333333333';

update public.menu_items set name_en = 'sundae soup', aliases = aliases || array['sundae soup','sausage soup','soup'], options = '[{"name":"맵기","choices":["안 맵게","보통","맵게"],"choices_en":["not spicy","regular","spicy"],"required":true}]' where id = '44444444-4444-4444-8444-444444444441';
update public.menu_items set name_en = 'pork soup', aliases = aliases || array['pork soup','pork rice soup'], options = '[{"name":"맵기","choices":["안 맵게","보통","맵게"],"choices_en":["not spicy","regular","spicy"],"required":true}]' where id = '44444444-4444-4444-8444-444444444442';
update public.menu_items set name_en = 'boiled pork', aliases = aliases || array['boiled pork','sliced pork','suyuk'] where id = '44444444-4444-4444-8444-444444444443';
update public.menu_items set name_en = 'black bean noodles', aliases = aliases || array['black bean noodles','jajangmyeon'], options = '[{"name":"크기","choices":["보통","곱빼기"],"choices_en":["regular","large"],"required":false}]' where id = '44444444-4444-4444-8444-444444444444';
update public.menu_items set name_en = 'spicy seafood noodles', aliases = aliases || array['spicy seafood noodles','seafood noodles','jjamppong'], options = '[{"name":"크기","choices":["보통","곱빼기"],"choices_en":["regular","large"],"required":false}]' where id = '44444444-4444-4444-8444-444444444445';
update public.menu_items set name_en = 'sweet and sour pork', aliases = aliases || array['sweet and sour pork','tangsuyuk'] where id = '44444444-4444-4444-8444-444444444446';
update public.menu_items set name_en = 'ten kilos of rice', aliases = aliases || array['rice','bag of rice'] where id = '44444444-4444-4444-8444-444444444447';
update public.menu_items set name_en = 'six bottles of water', aliases = aliases || array['water','bottled water'] where id = '44444444-4444-4444-8444-444444444448';
update public.menu_items set name_en = 'thirty rolls of toilet paper', aliases = aliases || array['toilet paper','tissue'] where id = '44444444-4444-4444-8444-444444444449';

insert into public.customers (id, phone_e164, name, default_address, lat, lng, preferred_speech_rate, is_demo) values
 ('11111111-1111-4111-8111-111111111113', '+14155550101', 'John Kim', '12 Haengbok-dong, Seoul', 37.5665, 126.9780, 1.0, true)
on conflict (id) do nothing;

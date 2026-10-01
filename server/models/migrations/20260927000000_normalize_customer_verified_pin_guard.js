/** Treat nullable address parts consistently when guarding verified customer pins. */
const normalizedAddress = row => `jsonb_build_array(
  COALESCE(NULLIF(${row}.address_line1, ''), ''),
  COALESCE(NULLIF(${row}.address_line2, ''), ''),
  COALESCE(NULLIF(${row}.city, ''), ''),
  COALESCE(NULLIF(${row}.state, ''), ''),
  COALESCE(NULLIF(${row}.zip, ''), '')
)`;

const normalizedReviewAddress = `jsonb_build_array(
  COALESCE(NULLIF(review.address_snapshot->>0, ''), ''),
  COALESCE(NULLIF(review.address_snapshot->>1, ''), ''),
  COALESCE(NULLIF(review.address_snapshot->>2, ''), ''),
  COALESCE(NULLIF(review.address_snapshot->>3, ''), ''),
  COALESCE(NULLIF(review.address_snapshot->>4, ''), '')
)`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE FUNCTION protect_customer_verified_pin() RETURNS trigger AS $$
    DECLARE review customer_geocode_reviews%ROWTYPE;
    BEGIN
      SELECT * INTO review FROM customer_geocode_reviews WHERE customer_id = OLD.id;
      IF review.status = 'verified'
        AND ${normalizedReviewAddress} = ${normalizedAddress('OLD')}
        AND OLD.latitude IS NOT DISTINCT FROM review.latitude
        AND OLD.longitude IS NOT DISTINCT FROM review.longitude
        AND ${normalizedAddress('NEW')} = ${normalizedAddress('OLD')} THEN
        NEW.latitude := OLD.latitude; NEW.longitude := OLD.longitude;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;`);
};

exports.down = async function down(knex) {
  await knex.raw(`CREATE OR REPLACE FUNCTION protect_customer_verified_pin() RETURNS trigger AS $$
    DECLARE review customer_geocode_reviews%ROWTYPE;
    BEGIN
      SELECT * INTO review FROM customer_geocode_reviews WHERE customer_id = OLD.id;
      IF review.status = 'verified'
        AND review.address_snapshot = jsonb_build_array(OLD.address_line1, OLD.address_line2, OLD.city, OLD.state, OLD.zip)
        AND OLD.latitude IS NOT DISTINCT FROM review.latitude
        AND OLD.longitude IS NOT DISTINCT FROM review.longitude
        AND ROW(NEW.address_line1, NEW.address_line2, NEW.city, NEW.state, NEW.zip)
          IS NOT DISTINCT FROM ROW(OLD.address_line1, OLD.address_line2, OLD.city, OLD.state, OLD.zip) THEN
        NEW.latitude := OLD.latitude; NEW.longitude := OLD.longitude;
      END IF;
      RETURN NEW;
    END;
  $$ LANGUAGE plpgsql;`);
};

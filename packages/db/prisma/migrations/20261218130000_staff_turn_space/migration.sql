-- Staff turns have no outlet. The shared trigger reads outletId and the insert fails.
-- Marketing actions keep that trigger: they have the column.

DROP TRIGGER IF EXISTS "owner_staff_turns_same_space" ON "owner_staff_turns";
CREATE TRIGGER "owner_staff_turns_same_space" BEFORE INSERT OR UPDATE ON "owner_staff_turns" FOR EACH ROW EXECUTE FUNCTION ops_same_restaurant_space();

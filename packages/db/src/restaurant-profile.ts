import { randomBytes } from "node:crypto";
import type { Actor, RestaurantOnboardingInput, RestaurantProfile } from "@rakazo/contracts";
import { RestaurantOnboardingInputSchema } from "@rakazo/contracts";
import { displayName } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * User-scoped memory the workspace's bots already load.
 * One computer per restaurant is unchanged: outlets are rows, not machines.
 */
export const RESTAURANT_PROFILE_PATH = "restaurant/profile.md";
export const RESTAURANT_OUTLETS_PATH = "restaurant/outlets.md";
export const RESTAURANT_MENU_PATH = "restaurant/menu.md";

export class RestaurantProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestaurantProfileError";
  }
}

type ProfileRow = Prisma.RestaurantProfileGetPayload<{ include: { outlets: true } }>;

type KnowledgeDocument = { path: string; content: string };

function newId(): string {
  return randomBytes(16).toString("hex");
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, "; ").trim();
}

function requireReadable(value: string, message: string): string {
  const readable = displayName(value, "");
  if (!readable) throw new RestaurantProfileError(message);
  return readable;
}

function storedMenuFileName(name: string | null): string | null {
  if (!name) return null;
  const base = name.replaceAll("\u0000", "").split(/[/\\]/).filter(Boolean).at(-1)?.trim() ?? "";
  return base ? base.slice(0, 200) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/** The details bots should see, as ordinary memory documents. */
export function restaurantKnowledgeDocuments(
  profile: Omit<RestaurantProfile, "completed" | "outlets"> & {
    outlets: { name: string; address: string; openingHours: string }[];
  },
): KnowledgeDocument[] {
  const line = (label: string, value: string) => `${label}: ${oneLine(value)}`;
  const contact = [
    line("Contact", profile.contactName),
    profile.contactEmail ? line("Email", profile.contactEmail) : "",
    profile.contactPhone ? line("Phone", profile.contactPhone) : "",
  ].filter(Boolean);
  const documents: KnowledgeDocument[] = [
    {
      path: RESTAURANT_PROFILE_PATH,
      content: [
        "# Restaurant",
        "",
        line("Name", profile.name),
        line("Cuisine", profile.cuisine),
        line("City", profile.city),
        ...contact,
        "",
      ].join("\n"),
    },
    {
      path: RESTAURANT_OUTLETS_PATH,
      content: [
        "# Outlets",
        "",
        ...profile.outlets.flatMap((outlet, index) => [
          `## ${index + 1}. ${oneLine(outlet.name)}`,
          line("Address", outlet.address),
          line("Opening hours", outlet.openingHours),
          "",
        ]),
      ].join("\n"),
    },
  ];
  const menu = profile.menuText.trim();
  const file = profile.menuFileName?.trim() ?? "";
  if (menu || file) {
    const parts = ["# Menu", ""];
    if (file) parts.push(line("File", file), "");
    if (menu) parts.push(menu.trimEnd());
    documents.push({ path: RESTAURANT_MENU_PATH, content: `${parts.join("\n").trimEnd()}\n` });
  }
  return documents;
}

function normalize(input: RestaurantOnboardingInput): RestaurantOnboardingInput {
  const parsed = RestaurantOnboardingInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new RestaurantProfileError(parsed.error.issues[0]?.message ?? "Check the restaurant");
  }
  return {
    ...parsed.data,
    name: requireReadable(parsed.data.name, "Add a restaurant name"),
    cuisine: requireReadable(parsed.data.cuisine, "Add the cuisine"),
    city: requireReadable(parsed.data.city, "Add the city"),
    contactName: requireReadable(parsed.data.contactName, "Add a contact name"),
    menuFileName: storedMenuFileName(parsed.data.menuFileName),
    outlets: parsed.data.outlets.map((outlet) => ({
      name: requireReadable(outlet.name, "Add a name, address, and opening hours for each outlet"),
      address: requireReadable(
        outlet.address,
        "Add a name, address, and opening hours for each outlet",
      ),
      openingHours: requireReadable(
        outlet.openingHours,
        "Add a name, address, and opening hours for each outlet",
      ),
    })),
  };
}

function toProfile(row: ProfileRow | null): RestaurantProfile | null {
  if (!row) return null;
  return {
    name: row.name,
    cuisine: row.cuisine,
    city: row.city,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    menuText: row.menuText,
    menuFileName: row.menuFileName,
    completed: row.completedAt != null,
    outlets: [...row.outlets]
      .sort((left, right) => left.position - right.position)
      .map((outlet) => ({
        id: outlet.id,
        name: outlet.name,
        address: outlet.address,
        openingHours: outlet.openingHours,
      })),
  };
}

const profileInclude = { outlets: { orderBy: { position: "asc" as const } } };

async function loadProfile(
  db: Prisma.TransactionClient | PrismaClient,
  spaceId: string,
): Promise<RestaurantProfile | null> {
  return toProfile(
    await db.restaurantProfile.findUnique({
      where: { spaceId },
      include: profileInclude,
    }),
  );
}

async function requireRestaurantOwner(tx: Prisma.TransactionClient, actor: Actor): Promise<string> {
  const { organizationId } = await lockSpaceForContentCreation(tx, {
    spaceId: actor.spaceId,
    userId: actor.userId,
  });
  const member = await tx.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    select: { role: true },
  });
  if (member?.role !== "owner") {
    throw new RestaurantProfileError("Only the restaurant owner can save this.");
  }
  return organizationId;
}

async function writeKnowledge(
  tx: Prisma.TransactionClient,
  actor: Actor,
  documents: KnowledgeDocument[],
): Promise<void> {
  const paths = new Set(documents.map((document) => document.path));
  if (!paths.has(RESTAURANT_MENU_PATH)) {
    await tx.memoryDocument.deleteMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "user",
        botId: null,
        path: RESTAURANT_MENU_PATH,
      },
    });
  }
  for (const document of documents) {
    const existing = await tx.memoryDocument.findFirst({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        scope: "user",
        botId: null,
        path: document.path,
      },
    });
    if (existing) {
      await tx.memoryDocument.update({
        where: { id: existing.id },
        data: { content: document.content, revision: existing.revision + 1 },
      });
    } else {
      await tx.memoryDocument.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          scope: "user",
          botId: null,
          path: document.path,
          content: document.content,
        },
      });
    }
  }
}

export async function getRestaurantProfile(
  prisma: PrismaClient,
  actor: Actor,
): Promise<RestaurantProfile | null> {
  return loadProfile(prisma, actor.spaceId);
}

/** True after restaurant signup has started and the welcome form is unfinished. */
export async function restaurantWelcomePending(
  prisma: PrismaClient,
  spaceId: string,
): Promise<boolean> {
  const row = await prisma.restaurantProfile.findUnique({
    where: { spaceId },
    select: { completedAt: true },
  });
  return row != null && row.completedAt == null;
}

/**
 * Bot and outlet totals for a later billing step.
 * Every bot that is not archived counts, including starter template bots.
 * This does not block creating more bots or outlets.
 */
export async function restaurantCounts(
  prisma: Pick<PrismaClient, "bot" | "restaurantOutlet">,
  spaceId: string,
): Promise<{ bots: number; outlets: number }> {
  const [bots, outlets] = await Promise.all([
    prisma.bot.count({ where: { spaceId, archivedAt: null } }),
    prisma.restaurantOutlet.count({ where: { spaceId } }),
  ]);
  return { bots, outlets };
}

/** Marks this workspace as a restaurant so welcome can finish. Does not add a computer. */
export async function beginRestaurantProfile(
  prisma: PrismaClient,
  actor: Actor,
): Promise<RestaurantProfile> {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const organizationId = await requireRestaurantOwner(tx, actor);
      const existing = await tx.restaurantProfile.findUnique({ where: { spaceId: actor.spaceId } });
      if (!existing) {
        try {
          await tx.restaurantProfile.create({
            data: {
              spaceId: actor.spaceId,
              organizationId,
              name: "",
              cuisine: "",
              city: "",
              contactName: "",
              contactEmail: "",
              contactPhone: "",
              menuText: "",
            },
          });
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          const raced = await tx.restaurantProfile.findUnique({
            where: { spaceId: actor.spaceId },
          });
          if (!raced) {
            throw new RestaurantProfileError(
              "This restaurant was already saved. Reload and try again.",
            );
          }
        }
      }
      const profile = await loadProfile(tx, actor.spaceId);
      if (!profile) throw new RestaurantProfileError("Check the restaurant");
      return profile;
    }),
  );
}

/**
 * Saves the welcome form, names the workspace after the restaurant, and writes
 * what bots should know. Outlets stay in this workspace's one computer.
 */
export async function saveRestaurantProfile(
  prisma: PrismaClient,
  actor: Actor,
  input: RestaurantOnboardingInput,
): Promise<RestaurantProfile> {
  const profile = normalize(input);
  const documents = restaurantKnowledgeDocuments(profile);
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const organizationId = await requireRestaurantOwner(tx, actor);
      const savedAt = new Date();
      const data = {
        name: profile.name,
        cuisine: profile.cuisine,
        city: profile.city,
        contactName: profile.contactName,
        contactEmail: profile.contactEmail,
        contactPhone: profile.contactPhone,
        menuText: profile.menuText,
        menuFileName: profile.menuFileName,
        completedAt: savedAt,
      };
      try {
        await tx.restaurantProfile.upsert({
          where: { spaceId: actor.spaceId },
          create: { spaceId: actor.spaceId, organizationId, ...data },
          update: data,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        throw new RestaurantProfileError(
          "This restaurant was already saved. Reload and try again.",
        );
      }
      await tx.restaurantOutlet.deleteMany({ where: { spaceId: actor.spaceId } });
      await tx.restaurantOutlet.createMany({
        data: profile.outlets.map((outlet, position) => ({
          id: newId(),
          spaceId: actor.spaceId,
          name: outlet.name,
          address: outlet.address,
          openingHours: outlet.openingHours,
          position,
        })),
      });
      await tx.space.update({ where: { id: actor.spaceId }, data: { name: profile.name } });
      await tx.organization.update({ where: { id: organizationId }, data: { name: profile.name } });
      await writeKnowledge(tx, actor, documents);
      const saved = await loadProfile(tx, actor.spaceId);
      if (!saved) throw new RestaurantProfileError("Check the restaurant");
      return saved;
    }),
  );
}

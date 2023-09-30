import type { Prisma } from "@prisma/client";

import { ALLOWED_HOSTNAMES, RESERVED_SUBDOMAINS, WEBAPP_URL } from "@calcom/lib/constants";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

/**
 * return the org slug
 * @param hostname
 */
export function getOrgSlug(hostname: string) {
  if (!hostname.includes(".")) {
    // A no-dot domain can never be org domain. It automatically handles localhost
    return null;
  }
  // Find which hostname is being currently used
  const currentHostname = ALLOWED_HOSTNAMES.find((ahn) => {
    const url = new URL(WEBAPP_URL);
    const testHostname = `${url.hostname}${url.port ? `:${url.port}` : ""}`;
    return testHostname.endsWith(`.${ahn}`);
  });
  if (currentHostname) {
    // Define which is the current domain/subdomain
    const slug = hostname.replace(`.${currentHostname}` ?? "", "");
    return slug.indexOf(".") === -1 ? slug : null;
  }
  return null;
}

export function orgDomainConfig(hostname: string, fallback?: string | string[]) {
  const currentOrgDomain = getOrgSlug(hostname);
  const isValidOrgDomain = currentOrgDomain !== null && !RESERVED_SUBDOMAINS.includes(currentOrgDomain);
  if (isValidOrgDomain || !fallback) {
    return {
      currentOrgDomain: isValidOrgDomain ? currentOrgDomain : null,
      isValidOrgDomain,
    };
  }
  const fallbackOrgSlug = fallback as string;
  const isValidFallbackDomain = !RESERVED_SUBDOMAINS.includes(fallbackOrgSlug);
  return {
    currentOrgDomain: isValidFallbackDomain ? fallbackOrgSlug : null,
    isValidOrgDomain: isValidFallbackDomain,
  };
}

export function subdomainSuffix() {
  const urlSplit = WEBAPP_URL.replace("https://", "")?.replace("http://", "").split(".");
  return urlSplit.length === 3 ? urlSplit.slice(1).join(".") : urlSplit.join(".");
}

export function getOrgFullDomain(slug: string, options: { protocol: boolean } = { protocol: true }) {
  return `${options.protocol ? `${new URL(WEBAPP_URL).protocol}//` : ""}${slug}.${subdomainSuffix()}`;
}

export function getSlugOrRequestedSlug(slug: string) {
  return {
    OR: [
      { slug },
      {
        metadata: {
          path: ["requestedSlug"],
          equals: slug,
        },
      },
    ],
  } satisfies Prisma.TeamWhereInput;
}

export function userOrgQuery(hostname: string, fallback?: string | string[]) {
  const { currentOrgDomain, isValidOrgDomain } = orgDomainConfig(hostname, fallback);
  return isValidOrgDomain && currentOrgDomain ? getSlugOrRequestedSlug(currentOrgDomain) : null;
}

export type OrganizationData = {
  metadata: Prisma.JsonValue;
  slug: string | null;
  id: number;
  name: string;
} | null;

export function parseOrgData(organization: OrganizationData) {
  const parsedOrgMetadata = teamMetadataSchema.parse(organization?.metadata ?? {});
  return organization?.id
    ? {
        id: organization.id,
        name: organization.name,
        slug: organization.slug ?? parsedOrgMetadata?.requestedSlug ?? "",
        fullDomain: getOrgFullDomain(organization.slug ?? parsedOrgMetadata?.requestedSlug ?? ""),
        domainSuffix: subdomainSuffix(),
      }
    : undefined;
}

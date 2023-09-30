import type { NextApiRequest, NextApiResponse } from "next";

import dayjs from "@calcom/dayjs";
import { checkPremiumUsername } from "@calcom/ee/common/lib/checkPremiumUsername";
import { hashPassword } from "@calcom/features/auth/lib/hashPassword";
import { sendEmailVerification } from "@calcom/features/auth/lib/verifyEmail";
import { IS_CALCOM } from "@calcom/lib/constants";
import slugify from "@calcom/lib/slugify";
import { closeComUpsertTeamUser } from "@calcom/lib/sync/SyncServiceManager";
import { validateUsernameInToken, validateUsername } from "@calcom/lib/validateUsername";
import prisma from "@calcom/prisma";
import { IdentityProvider } from "@calcom/prisma/enums";
import { MembershipRole } from "@calcom/prisma/enums";
import { signupSchema } from "@calcom/prisma/zod-utils";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

async function upsertUser(data: {
  username: string;
  userEmail: string;
  orgId?: number | null;
  hashedPassword: string;
}) {
  const { userEmail, username, orgId, hashedPassword } = data;
  let user = await prisma.user.findFirst({
    where: { email: userEmail, username, organizationId: orgId },
    select: { id: true, email: true, name: true, username: true, createdDate: true },
  });
  const parentUser = await prisma.user.findFirst({
    where: { email: userEmail, linkedByUserId: null },
    select: { id: true, emailVerified: true, linkedUsers: { select: { id: true } } },
  });
  if (!user) {
    user = await prisma.user.create({
      data: {
        username,
        email: userEmail,
        emailVerified: parentUser?.emailVerified || undefined,
        password: hashedPassword,
        identityProvider: IdentityProvider.CAL,
        ...(orgId
          ? {
              organization: {
                connect: {
                  id: orgId,
                },
              },
            }
          : {}),
        ...(parentUser
          ? {
              linkedBy: {
                connect: {
                  id: parentUser?.id,
                },
              },
            }
          : {}),
      },
    });
  } else {
    await prisma.user.updateMany({
      where: { email: userEmail, username, organizationId: orgId },
      data: {
        username,
        password: hashedPassword,
        emailVerified: new Date(Date.now()),
        identityProvider: IdentityProvider.CAL,
        ...(orgId
          ? {
              organization: {
                connect: {
                  id: orgId,
                },
              },
            }
          : {}),
        ...(parentUser
          ? {
              linkedBy: {
                connect: {
                  id: parentUser?.id,
                },
              },
            }
          : {}),
      },
    });
  }
  if (parentUser) {
    await prisma.user.updateMany({
      where: { id: { in: [parentUser.id].concat(parentUser.linkedUsers.map((user) => user.id)) } },
      data: { password: hashedPassword },
    });
  }
  return user;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  if (process.env.NEXT_PUBLIC_DISABLE_SIGNUP === "true") {
    res.status(403).json({ message: "Signup is disabled" });
    return;
  }

  const data = req.body;
  const { email, password, language, token } = signupSchema.parse(data);

  const username = slugify(data.username);
  const userEmail = email.toLowerCase();

  if (!username) {
    res.status(422).json({ message: "Invalid username" });
    return;
  }

  let foundToken: { id: number; identifier: string; teamId: number | null; expires: Date } | null = null;
  if (token) {
    foundToken = await prisma.verificationToken.findFirst({
      where: {
        token,
      },
      select: {
        id: true,
        identifier: true,
        expires: true,
        teamId: true,
      },
    });

    if (!foundToken) {
      return res.status(401).json({ message: "Invalid Token" });
    }

    if (dayjs(foundToken?.expires).isBefore(dayjs())) {
      return res.status(401).json({ message: "Token expired" });
    }
    if (foundToken?.teamId !== null) {
      const teamId = foundToken.teamId;
      const teamUserValidation = await validateUsernameInToken(username, userEmail, {
        ...foundToken,
        teamId,
      });
      if (!teamUserValidation.isValid) {
        return res.status(409).json({ message: "Username or email is already taken" });
      }
    }
  } else {
    const userValidation = await validateUsername(username, userEmail);
    if (!userValidation.isValid) {
      return res.status(409).json({ message: "Username or email is already taken" });
    }
  }

  const hashedPassword = await hashPassword(password);

  if (foundToken && foundToken?.teamId) {
    const team = await prisma.team.findUnique({
      where: {
        id: foundToken.teamId,
      },
    });
    if (team) {
      const teamMetadata = teamMetadataSchema.parse(team?.metadata);

      if (IS_CALCOM && (!teamMetadata?.isOrganization || !!team.parentId)) {
        const checkUsername = await checkPremiumUsername(username);
        if (checkUsername.premium) {
          // This signup page is ONLY meant for team invites and local setup. Not for every day users.
          // In singup redesign/refactor coming up @sean will tackle this to make them the same API/page instead of two.
          return res.status(422).json({
            message: "Sign up from https://cal.com/signup to claim your premium username",
          });
        }
      }

      // Identify the org id in an org context signup, either the invited team is an org
      // or has a parentId, otherwise parentId will be null, making orgId null
      const orgId = teamMetadata?.isOrganization ? team.id : team.parentId;
      const user = await upsertUser({ userEmail, username, hashedPassword, orgId });

      const membership = await prisma.membership.upsert({
        where: {
          userId_teamId: { userId: user.id, teamId: team.id },
        },
        update: {
          accepted: true,
        },
        create: {
          userId: user.id,
          teamId: team.id,
          accepted: true,
          role: MembershipRole.MEMBER,
        },
      });
      closeComUpsertTeamUser(team, user, membership.role);

      // Accept any child team invites for orgs and create a membership for the org itself
      if (team.parentId) {
        // Create (when invite link is used) or Update (when regular email invitation is used) membership for the organization itself
        await prisma.membership.upsert({
          where: {
            userId_teamId: { userId: user.id, teamId: team.parentId },
          },
          update: {
            accepted: true,
          },
          create: {
            userId: user.id,
            teamId: team.parentId,
            accepted: true,
            role: MembershipRole.MEMBER,
          },
        });

        // We do a membership update twice so we can join the ORG invite if the user is invited to a team witin a ORG
        await prisma.membership.updateMany({
          where: {
            userId: user.id,
            team: {
              id: team.parentId,
            },
            accepted: false,
          },
          data: {
            accepted: true,
          },
        });

        // Join any other invites
        await prisma.membership.updateMany({
          where: {
            userId: user.id,
            team: {
              parentId: team.parentId,
            },
            accepted: false,
          },
          data: {
            accepted: true,
          },
        });
      }
    }

    // Cleanup token after use
    await prisma.verificationToken.delete({
      where: {
        id: foundToken.id,
      },
    });
  } else {
    if (IS_CALCOM) {
      const checkUsername = await checkPremiumUsername(username);
      if (checkUsername.premium) {
        res.status(422).json({
          message: "Sign up from https://cal.com/signup to claim your premium username",
        });
        return;
      }
    }
    await upsertUser({ userEmail, hashedPassword, username, orgId: undefined });
    await sendEmailVerification({
      email: userEmail,
      username,
      language,
    });
  }

  res.status(201).json({ message: "Created user" });
}

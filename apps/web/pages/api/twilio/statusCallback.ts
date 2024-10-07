/* Schedule any workflow reminder that falls within 72 hours for email */
import type { NextApiRequest, NextApiResponse } from "next";
import twilio from "twilio";

import dayjs from "@calcom/dayjs";
import { createTwilioClient } from "@calcom/features/ee/workflows/lib/reminders/providers/twilioProvider";
import type { TeamOrUserId } from "@calcom/features/ee/workflows/lib/reminders/smsReminderManager";
import {
  addCredits,
  cancelScheduledSmsAndScheduleEmails,
  getTeamIdToBeCharged,
  smsCreditCountSelect,
} from "@calcom/features/ee/workflows/lib/smsCredits/smsCreditsUtils";
import { defaultHandler } from "@calcom/lib/server";
import prisma from "@calcom/prisma";

const twilioClient = createTwilioClient();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authToken = process.env.TWILIO_TOKEN;

  const twilioSignature = req.headers["x-twilio-signature"];
  const baseUrl = `${process.env.NEXT_PUBLIC_WEBAPP_URL}/api/twilio/statusCallback`;

  const queryParams = new URLSearchParams(req.query as Record<string, string>).toString();
  const url = queryParams ? `${baseUrl}?${queryParams}` : baseUrl;

  if (typeof twilioSignature === "string") {
    const valid = twilio.validateRequest(authToken ?? "", twilioSignature, url, req.body);

    if (valid) {
      const messageStatus = req.body.MessageStatus;
      const { userId, teamId, teamIdToCharge, userIdToCharge } = req.query;

      if (messageStatus === "delivered" || messageStatus === "undelivered") {
        const parsedUserId = userId ? (Array.isArray(userId) ? Number(userId[0]) : Number(userId)) : null;
        const parsedTeamId = teamId ? (Array.isArray(teamId) ? Number(teamId[0]) : Number(teamId)) : null;
        const parsedTeamIdToCharge = teamIdToCharge
          ? Array.isArray(teamIdToCharge)
            ? Number(teamIdToCharge[0])
            : Number(teamIdToCharge)
          : null;

        const parsedUserIdToCharge = userIdToCharge
          ? Array.isArray(userIdToCharge)
            ? Number(userIdToCharge[0])
            : Number(userIdToCharge)
          : null;

        let teamOrUserToCharge: TeamOrUserId | null = parsedTeamIdToCharge
          ? { teamId: parsedTeamIdToCharge }
          : parsedUserIdToCharge
          ? { userId: parsedUserIdToCharge }
          : null;

        if (!teamOrUserToCharge) {
          teamOrUserToCharge = await getTeamIdToBeCharged({ userId: parsedUserId, teamId: parsedTeamId });
        }

        if (teamOrUserToCharge) {
          const isFree = await addCredits(req.body.To, teamOrUserToCharge, parsedUserId);

          if (!isFree && parsedTeamIdToCharge) {
            const costsString = (await twilioClient.messages(req.body.MessageSid).fetch()).price;

            const costs = Math.abs(parseFloat(costsString));

            const teamCredits = await prisma.smsCreditCount.findFirst({
              where: {
                teamId: parsedTeamIdToCharge,
                userId: null,
                month: dayjs().utc().startOf("month").toDate(),
              },
              select: smsCreditCountSelect,
            });

            if (
              teamCredits &&
              teamCredits.team &&
              teamCredits.overageCharges + costs < teamCredits.team.smsOverageLimit
            ) {
              await prisma.smsCreditCount.update({
                where: {
                  id: teamCredits.id,
                },
                data: {
                  overageCharges: {
                    increment: costs,
                  },
                },
              });
            }
          }
        } else {
          // if we don't have a team to charge, user doesn't have any available sms for personal event types.
          cancelScheduledSmsAndScheduleEmails({ userId: parsedUserId });
        }
        if (teamIdToCharge) {
          return res
            .status(200)
            .send(`Credits added to teamId: ${teamIdToCharge} (userId: ${parsedUserId}) `);
        } else {
          return res.status(200).send(`SMS limit reached`);
        }
      }
      return res.status(200).send(`SMS not yet delivered`);
    } else {
      return res.status(401).send("Missing or invalid Twilio signature");
    }
  }
}

export default defaultHandler({
  POST: Promise.resolve({ default: handler }),
});

import type { FeatureFlagRepository } from "@calcom/lib/server/repository/featureFlag";
import { trpc } from "@calcom/trpc/react";
import type { RouterOutputs } from "@calcom/trpc/react";
import { Badge, List, ListItem, ListItemText, ListItemTitle, Switch, showToast } from "@calcom/ui";

export type FlagAdminListProps = {
  ssrProps?: {
    featureFlags?: Awaited<ReturnType<typeof FeatureFlagRepository.getFeatureFlags>>;
  };
  revalidateCache?: () => Promise<void>;
};

export const FlagAdminList = ({ ssrProps, revalidateCache }: FlagAdminListProps) => {
  const [_data] = trpc.viewer.features.list.useSuspenseQuery();
  const data = ssrProps?.featureFlags ?? _data;

  return (
    <List roundContainer noBorderTreatment>
      {data.map((flag) => (
        <ListItem key={flag.slug} rounded={false}>
          <div className="flex flex-1 flex-col">
            <ListItemTitle component="h3">
              {flag.slug}
              &nbsp;&nbsp;
              <Badge variant="green">{flag.type?.replace("_", " ")}</Badge>
            </ListItemTitle>
            <ListItemText component="p">{flag.description}</ListItemText>
          </div>
          <div className="flex py-2">
            <FlagToggle flag={flag} onSuccess={revalidateCache} />
          </div>
        </ListItem>
      ))}
    </List>
  );
};

type Flag = RouterOutputs["viewer"]["features"]["list"][number];

const FlagToggle = (props: { flag: Flag; onSuccess?: () => void }) => {
  const {
    flag: { slug, enabled },
  } = props;
  const utils = trpc.useUtils();
  const mutation = trpc.viewer.admin.toggleFeatureFlag.useMutation({
    onSuccess: () => {
      showToast("Flags successfully updated", "success");
      utils.viewer.features.list.invalidate();
      utils.viewer.features.map.invalidate();
      props.onSuccess?.();
    },
  });
  return (
    <Switch
      defaultChecked={enabled}
      onCheckedChange={(checked) => {
        mutation.mutate({ slug, enabled: checked });
      }}
    />
  );
};

import { Avatar, AvatarFallback, AvatarImage } from "@halinka/ui/components/avatar";

export type GitHubAvatarProps = { login: string; className?: string };

export const GitHubAvatar = (props: GitHubAvatarProps) => {
  const { login, className } = props;

  return (
    <Avatar size="sm" className={className}>
      <AvatarImage src={`https://github.com/${encodeURIComponent(login)}.png?size=48`} alt="" />
      <AvatarFallback>{login.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
};

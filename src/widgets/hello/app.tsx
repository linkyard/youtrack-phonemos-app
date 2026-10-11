import React, {memo} from 'react';

// Register widget in YouTrack. To learn more, see https://www.jetbrains.com/help/youtrack/devportal-apps/apps-host-api.html
await YTApp.register();

const issueId = YTApp.entity?.id;
const userName = YTApp.me?.name ?? YTApp.me?.login;

const AppComponent: React.FunctionComponent = () => (
  <div className="widget">
    <strong>Hello from Phonemos</strong>
    {(issueId || userName) && (
      <span className="context">
        {issueId && <>Issue {issueId}</>}
        {issueId && userName && ' · '}
        {userName && <>{userName}</>}
      </span>
    )}
  </div>
);

export const App = memo(AppComponent);

import { useId, type ReactNode } from 'react';
import { groupModelOptions, type ImageModelOption } from '@/lib/imageModelOptions';
import './ModelOptionGroups.css';

export default function ModelOptionGroups<Option extends ImageModelOption>({ options, children }: {
  options: Option[];
  children: (option: Option) => ReactNode;
}) {
  const headingId = useId();
  return (
    <div className="model-option-groups">
      {groupModelOptions(options).map((group, index) => (
        <div className="model-option-group" key={group.profileId} role="group" aria-labelledby={`${headingId}-${index}`}>
          <p className="model-option-group-heading" id={`${headingId}-${index}`}>{group.profileName}</p>
          {group.options.map(children)}
        </div>
      ))}
    </div>
  );
}

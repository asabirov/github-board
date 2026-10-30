import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PeopleController } from './people.controller';
import { PEOPLE_SOURCE } from './people-source';
import { FixturePeopleSource } from './fixture.people.source';
import { IdentityModule } from '../identity/identity.module';
import { parseGithubAllowList } from '../auth/github-admission.service';

/**
 * Team roster. With GitHub-only sign-in the roster is the plain-login portion of
 * `BOARD_ALLOWED_GITHUB`; an empty allow list admits everyone, so it names
 * nobody in particular.
 */
@Module({
  imports: [IdentityModule],
  controllers: [PeopleController],
  providers: [
    {
      provide: PEOPLE_SOURCE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const list = parseGithubAllowList(config.get<string>('BOARD_ALLOWED_GITHUB', ''));
        return new FixturePeopleSource(list.logins);
      },
    },
  ],
  // Exported so the admin Access panel can reuse the same roster source rather
  // than standing up a second one with divergent config.
  exports: [PEOPLE_SOURCE],
})
export class PeopleModule {}

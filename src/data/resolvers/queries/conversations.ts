import {
  Brands,
  Channels,
  ConversationMessages,
  Conversations,
  Tags
} from "../../../db/models";
import { IUserDocument } from "../../../db/models/definitions/users";

import {
  CONVERSATION_STATUSES,
  INTEGRATION_KIND_CHOICES
} from "../../constants";
import { moduleRequireLogin } from "../../permissions";
import QueryBuilder from "./conversationQueryBuilder";

interface IListArgs {
  limit: number;
  channelId: string;
  status: string;
  unassigned: string;
  brandId: string;
  tag: string;
  integrationType: string;
  participating: string;
  starred: string;
  ids: string[];
  startDate: string;
  endDate: string;
  only?: string;
}

// count helper
const count = async query => Conversations.find(query).count();

const countByChannels = async qb => {
  const byChannels = {};
  const channels = await Channels.find();

  for (const channel of channels) {
    byChannels[channel._id] = await count({
      ...qb.mainQuery(),
      ...(await qb.channelFilter(channel._id))
    });
  }

  return byChannels;
};

const countByIntegrationTypes = async qb => {
  const byIntegrationTypes = {};

  for (const intT of INTEGRATION_KIND_CHOICES.ALL) {
    byIntegrationTypes[intT] = await count({
      ...qb.mainQuery(),
      ...(await qb.integrationTypeFilter(intT))
    });
  }

  return byIntegrationTypes;
};

const countByTags = async qb => {
  const byTags = {};
  const queries = qb.queries;
  const tags = await Tags.find();

  for (const tag of tags) {
    byTags[tag._id] = await count({
      ...qb.mainQuery(),
      ...queries.integrations,
      ...queries.integrationType,
      ...qb.tagFilter(tag._id)
    });
  }

  return byTags;
};

const countByBrands = async qb => {
  const byBrands = {};
  const brands = await Brands.find();

  for (const brand of brands) {
    byBrands[brand._id] = await count({
      ...qb.mainQuery(),
      ...qb.intersectIntegrationIds(
        qb.queries.channel,
        await qb.brandFilter(brand._id)
      )
    });
  }

  return byBrands;
};

const conversationQueries = {
  /**
   * Conversataions list
   */
  async conversations(_root, params, { user }) {
    // filter by ids of conversations
    if (params && params.ids) {
      return Conversations.find({ _id: { $in: params.ids } }).sort({
        createdAt: -1
      });
    }

    // initiate query builder
    const qb = new QueryBuilder(params, {
      _id: user._id,
      starredConversationIds: user.starredConversationIds
    });

    await qb.buildAllQueries();

    return Conversations.find(qb.mainQuery())
      .sort({ updatedAt: -1 })
      .limit(params.limit);
  },

  /**
   * Get conversation messages
   */
  async conversationMessages(_root, { conversationId, skip, limit }) {
    const query = { conversationId };

    if (limit) {
      const messages = await ConversationMessages.find(query)
        .sort({ createdAt: -1 })
        .skip(skip || 0)
        .limit(limit);

      return messages.reverse();
    }

    return ConversationMessages.find(query).sort({ createdAt: 1 });
  },

  /**
   *  Get all conversation messages count. We will use it in pager
   */
  async conversationMessagesTotalCount(
    _root,
    { conversationId }: { conversationId: string }
  ) {
    return ConversationMessages.count({ conversationId });
  },

  /**
   * Group conversation counts by brands, channels, integrations, status
   */
  async conversationCounts(
    _root,
    params: IListArgs,
    { user }: { user: IUserDocument }
  ) {
    const { only } = params;

    const response: any = {};

    const qb = new QueryBuilder(params, {
      _id: user._id,
      starredConversationIds: user.starredConversationIds
    });

    await qb.buildAllQueries();

    const queries = qb.queries;

    switch (only) {
      case "byChannels":
        response.byChannels = await countByChannels(qb);
        break;

      case "byIntegrationTypes":
        response.byIntegrationTypes = await countByIntegrationTypes(qb);
        break;

      case "byBrands":
        response.byBrands = await countByBrands(qb);
        break;

      case "byTags":
        response.byTags = await countByTags(qb);
        break;
    }

    // unassigned count
    response.unassigned = await count({
      ...qb.mainQuery(),
      ...queries.integrations,
      ...queries.integrationType,
      ...qb.unassignedFilter()
    });

    // participating count
    response.participating = await count({
      ...qb.mainQuery(),
      ...queries.integrations,
      ...queries.integrationType,
      ...qb.participatingFilter()
    });

    // starred count
    response.starred = await count({
      ...qb.mainQuery(),
      ...queries.integrations,
      ...queries.integrationType,
      ...qb.starredFilter()
    });

    // resolved count
    response.resolved = await count({
      ...qb.mainQuery(),
      ...queries.integrations,
      ...queries.integrationType,
      ...qb.statusFilter(["closed"])
    });

    return response;
  },

  /**
   * Get one conversation
   */
  conversationDetail(_root, { _id }: { _id: string }) {
    return Conversations.findOne({ _id });
  },

  /**
   * Get all conversations count. We will use it in pager
   */
  async conversationsTotalCount(
    _root,
    params: IListArgs,
    { user }: { user: IUserDocument }
  ) {
    // initiate query builder
    const qb = new QueryBuilder(params, {
      _id: user._id,
      starredConversationIds: user.starredConversationIds
    });

    await qb.buildAllQueries();

    return Conversations.find(qb.mainQuery()).count();
  },

  /**
   * Get last conversation
   */
  async conversationsGetLast(
    _root,
    params: IListArgs,
    { user }: { user: IUserDocument }
  ) {
    // initiate query builder
    const qb = new QueryBuilder(params, {
      _id: user._id,
      starredConversationIds: user.starredConversationIds
    });

    await qb.buildAllQueries();

    return Conversations.findOne(qb.mainQuery()).sort({ updatedAt: -1 });
  },

  /**
   * Get all unread conversations for logged in user
   */
  async conversationsTotalUnreadCount(
    _root,
    _args,
    { user }: { user: IUserDocument }
  ) {
    // initiate query builder
    const qb = new QueryBuilder({}, { _id: user._id });

    // get all possible integration ids
    const integrationsFilter = await qb.integrationsFilter();

    return Conversations.find({
      ...integrationsFilter,
      status: { $in: [CONVERSATION_STATUSES.NEW, CONVERSATION_STATUSES.OPEN] },
      readUserIds: { $ne: user._id },

      // exclude engage messages if customer did not reply
      $or: [
        {
          userId: { $exists: true },
          messageCount: { $gt: 1 }
        },
        {
          userId: { $exists: false }
        }
      ]
    }).count();
  }
};

moduleRequireLogin(conversationQueries);

export default conversationQueries;